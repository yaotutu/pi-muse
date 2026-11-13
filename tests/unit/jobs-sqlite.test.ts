import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobRepository } from "../../src/adapters/storage/job-repository.js";
import { jobsModule } from "../../src/adapters/storage/jobs-schema.js";
import { InvalidDocumentError } from "../../src/adapters/storage/document-schemas.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { openSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { createJobService } from "../../src/features/jobs/job-service.js";
import type { Job } from "../../src/features/jobs/types.js";

const TIMESTAMP = "2030-01-01T00:00:00.000Z";

/** 每个用例独立目录与独立 main.sqlite；模块账本在开库后立即登记。 */
const openJobs = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-muse-jobs-sqlite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "main.sqlite");
  const managed = await openSqliteDatabase(file);
  t.after(() => managed.close());
  await managed.serialize(() => ensureSqliteModules(managed, [jobsModule]));
  return { directory, file, managed, repository: createJobRepository(managed) };
};

const job = (id: string, overrides: Partial<Job> = {}): Job => ({
  id,
  prompt: `prompt-${id}`,
  daily: false,
  at: TIMESTAMP,
  enabled: true,
  createdAt: "2029-01-01T00:00:00.000Z",
  nextRunAt: TIMESTAMP,
  originSessionId: "main",
  ...overrides,
});

const totalChanges = (managed: Awaited<ReturnType<typeof openJobs>>["managed"]): number =>
  Number((managed.database.prepare("SELECT total_changes() AS n").get() as { n: number }).n);

test("新增、修改与删除任务后读取结果一致", async (t) => {
  const { repository } = await openJobs(t);
  const first = job("a");
  const second = job("b", { prompt: "second" });

  await repository.update(() => ({ items: [first, second], result: undefined }));
  assert.deepEqual(await repository.read(), [first, second]);

  const updated = { ...first, prompt: "changed", updatedAt: "2029-02-01T00:00:00.000Z" };
  await repository.update((items) => ({
    items: items.map((item) => (item.id === first.id ? updated : item)),
    result: undefined,
  }));
  assert.deepEqual(await repository.read(), [updated, second]);

  await repository.update((items) => ({
    items: items.filter((item) => item.id !== second.id),
    result: undefined,
  }));
  assert.deepEqual(await repository.read(), [updated]);
});

test("未命中与只读 update 都不写库", async (t) => {
  const { managed, repository } = await openJobs(t);
  const existing = job("a");
  await repository.update(() => ({ items: [existing], result: undefined }));

  const before = totalChanges(managed);
  // 未返回 items：纯查询，既不落盘也不通知。
  assert.equal(await repository.update(() => ({ result: "read-only" })), "read-only");
  // 返回未命中的结果：同样不写库。
  assert.equal(
    await repository.update((items) => ({ result: items.find((item) => item.id === "missing")?.id })),
    undefined,
  );
  // 返回与库内完全相同的 items：行级 diff 没有变化，不产生任何写入。
  assert.equal(await repository.update((items) => ({ items, result: "unchanged" })), "unchanged");
  assert.equal(totalChanges(managed), before);
  assert.deepEqual(await repository.read(), [existing]);
});

test("任务顺序稳定，删除后其余任务保持原有次序", async (t) => {
  const { managed, repository } = await openJobs(t);
  const jobs = [job("a"), job("b"), job("c")];
  await repository.update(() => ({ items: jobs, result: undefined }));
  assert.deepEqual((await repository.read()).map((item) => item.id), ["a", "b", "c"]);

  await repository.update((items) => ({
    items: items.filter((item) => item.id !== "b"),
    result: undefined,
  }));
  const remaining = await repository.read();
  assert.deepEqual(remaining.map((item) => item.id), ["a", "c"]);
  const positions = managed.database.prepare("SELECT id, position FROM jobs ORDER BY position").all() as Array<{ id: string; position: number }>;
  assert.deepEqual(positions.map((row) => ({ id: row.id, position: row.position })), [{ id: "a", position: 0 }, { id: "c", position: 1 }]);

  // 新增追加到尾部，不改变既有任务的相对次序。
  const appended = job("d");
  await repository.update((items) => ({ items: [...items, appended], result: undefined }));
  assert.deepEqual((await repository.read()).map((item) => item.id), ["a", "c", "d"]);
});

test("daily 与 once 的非法时刻在库内约束与写入路径都被拒绝", async (t) => {
  const { managed, repository } = await openJobs(t);
  const insert = (id: string, daily: number, at: string) => managed.database.prepare(
    "INSERT INTO jobs (id, position, prompt, daily, at, enabled, created_at, next_run_at) VALUES (?, 0, 'p', ?, ?, 1, ?, ?)",
  ).run(id, daily, at, TIMESTAMP, TIMESTAMP);

  // 库内 CHECK 直接拒绝非法时刻，不做进位或兜底。
  for (const [daily, at] of [[1, "24:00"], [1, "9:00"], [1, "09:99"], [1, "invalid"], [0, "2030-02-30T00:00:00Z"], [0, "2030-01-01T00:00:00"]] as const) {
    assert.throws(() => insert(`bad-${daily}-${at}`, daily, at), /CHECK constraint failed/);
  }
  assert.deepEqual(await repository.read(), []);

  // 写入路径同样拒绝非法时刻，且不会留下半条记录。
  for (const overrides of [{ daily: true, at: "24:00" }, { daily: false, at: "not-a-date" }]) {
    await assert.rejects(
      repository.update(() => ({ items: [job("bad", overrides)], result: undefined })),
      InvalidDocumentError,
    );
    assert.deepEqual(await repository.read(), []);
  }
});

test("控制状态、最后控制、最后结果与执行状态语义保真", async (t) => {
  const { repository } = await openJobs(t);
  const service = createJobService(repository);
  const created = await service.add("daily task", true, "10:30");

  assert.equal((await service.control(created.id, "pause")).ok, true);
  const paused = (await service.get(created.id))!;
  assert.equal(paused.enabled, false);
  assert.equal(paused.controlState, "paused");
  assert.equal(paused.lastControl?.action, "pause");
  assert.ok(Number.isFinite(Date.parse(paused.lastControl!.at)));

  const completed = new Date(2030, 0, 2, 10, 31);
  const marked = (await service.markRun(created.id, "failed", "boom", completed))!;
  assert.equal(marked.lastStatus, "failed");
  assert.equal(marked.lastResult, "boom");
  assert.equal(marked.lastRunAt, completed.toISOString());
  // 暂停状态不被执行结果覆盖，控制事实仍然保留。
  assert.equal(marked.controlState, "paused");
  assert.equal(marked.lastControl?.action, "pause");

  // 失败且没有待处理控制的任务才能重试。
  const retryable = await service.add("retry task", false, TIMESTAMP);
  await service.markRun(retryable.id, "failed", "boom");
  assert.equal((await service.control(retryable.id, "retry")).ok, true);
  const retried = (await service.get(retryable.id))!;
  assert.equal(retried.controlState, "retry_pending");
  assert.equal(retried.lastControl?.action, "retry");

  const stored = await repository.read();
  assert.deepEqual(stored.map((item) => item.id), [created.id, retryable.id]);
  assert.deepEqual(stored[0], marked);
  assert.deepEqual(stored[1], retried);

  // 未发生的控制不产生占位字段。
  const plain = job("plain");
  await repository.update(() => ({ items: [...stored, plain], result: undefined }));
  const withPlain = await repository.read();
  assert.equal("lastStatus" in withPlain[2]!, false);
  assert.equal("lastControl" in withPlain[2]!, false);
  assert.equal("controlState" in withPlain[2]!, false);
  assert.equal("updatedAt" in withPlain[2]!, false);
  assert.equal("originSessionId" in withPlain[2]!, true);
});

test("重启后新连接读到同样的任务", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-muse-jobs-sqlite-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "main.sqlite");

  const first = await openSqliteDatabase(file);
  await first.serialize(() => ensureSqliteModules(first, [jobsModule]));
  const stored = [job("a"), job("b", { daily: true, at: "23:59" })];
  await createJobRepository(first).update(() => ({ items: stored, result: undefined }));
  await first.close();

  const second = await openSqliteDatabase(file);
  t.after(() => second.close());
  await second.serialize(() => ensureSqliteModules(second, [jobsModule]));
  assert.deepEqual(await createJobRepository(second).read(), stored);
});

test("并发写入在同一 serialize 队列上串行，不丢任务也不乱序", async (t) => {
  const { repository } = await openJobs(t);
  const service = createJobService(repository);
  const created = await Promise.all(
    Array.from({ length: 20 }, (_, index) => service.add(`job-${index}`, false, TIMESTAMP)),
  );
  assert.equal(created.length, 20);
  const listed = await repository.read();
  assert.deepEqual(listed.map((item) => item.id), created.map((item) => item.id));
  assert.deepEqual(listed, created);
});

test("重复 id 被拒绝，不会静默覆盖既有任务", async (t) => {
  const { repository } = await openJobs(t);
  const first = job("same");
  await repository.update(() => ({ items: [first], result: undefined }));
  await assert.rejects(
    repository.update(() => ({ items: [first, { ...first, prompt: "second" }], result: undefined })),
    InvalidDocumentError,
  );
  assert.deepEqual(await repository.read(), [first]);
});

test("按来源会话删除任务只删除该来源的任务", async (t) => {
  const { repository } = await openJobs(t);
  const service = createJobService(repository);
  await service.add("main task", false, TIMESTAMP, "main");
  await service.add("other task", false, TIMESTAMP, "other-session");

  assert.equal(await service.removeByOriginSessionId("other-session"), 1);
  const remaining = await repository.read();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.originSessionId, "main");
});

test("被直接写坏的记录在读取时明确报错，不被静默过滤", async (t) => {
  const { managed, repository } = await openJobs(t);
  await repository.update(() => ({ items: [job("a")], result: undefined }));
  // 绕过库内约束写入坏时刻：读取必须暴露损坏，而不是返回空集或默认值。
  managed.database.exec("PRAGMA ignore_check_constraints = ON");
  managed.database.prepare(
    "INSERT INTO jobs (id, position, prompt, daily, at, enabled, created_at, next_run_at) VALUES ('broken', 1, 'p', 1, '99:99', 1, ?, ?)",
  ).run(TIMESTAMP, TIMESTAMP);
  managed.database.exec("PRAGMA ignore_check_constraints = OFF");

  await assert.rejects(repository.read(), InvalidDocumentError);
  await assert.rejects(repository.update(() => ({ result: undefined })), InvalidDocumentError);
});

test("未登记 jobs 模块时明确失败，不静默建表", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-muse-jobs-sqlite-unregistered-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managed = await openSqliteDatabase(join(directory, "main.sqlite"));
  t.after(() => managed.close());
  await assert.rejects(
    createJobRepository(managed).read(),
    /Invalid main database: module jobs is missing table jobs/,
  );
});
