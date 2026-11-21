import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobRepository } from "../../src/adapters/storage/job-repository.js";
import { jobsModule } from "../../src/adapters/storage/jobs-schema.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { openSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { createJobService } from "../../src/features/jobs/job-service.js";
import { nextRunAfter } from "../../src/features/jobs/schedule-calculator.js";
import type { Job } from "../../src/features/jobs/types.js";

/** 定时任务事实现在在 main.sqlite；每个用例独立库，模块账本先登记再使用。 */
const tempDatabase = async (t: { after: (cleanup: () => Promise<void>) => void }) => {
  const directory = await mkdtemp(join(tmpdir(), "personal-bot-jobs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "main.sqlite");
  const managed = await openSqliteDatabase(file);
  t.after(() => managed.close());
  await managed.serialize(() => ensureSqliteModules(managed, [jobsModule]));
  return { file, managed, repository: createJobRepository(managed) };
};

/** 库内写入计数：用来证明“未命中/只读 update”没有产生任何写入。 */
const totalChanges = (managed: Awaited<ReturnType<typeof tempDatabase>>["managed"]): number =>
  Number((managed.database.prepare("SELECT total_changes() AS n").get() as { n: number }).n);

const baseJob = (id: string): Job => ({
  id,
  prompt: "legacy prompt",
  daily: false,
  at: "2030-01-01T00:00:00.000Z",
  enabled: true,
  createdAt: "2029-01-01T00:00:00.000Z",
  nextRunAt: "2030-01-01T00:00:00.000Z",
  originSessionId: "main",
});

test("nextRunAfter keeps one-time and daily scheduling semantics", () => {
  // 每日日程基于本地时区；测试不预设运行环境为 UTC。
  const after = new Date(2030, 0, 1, 10, 30);
  assert.equal(
    nextRunAfter(false, "2030-01-02T00:00:00.000Z", after),
    "2030-01-02T00:00:00.000Z",
  );
  assert.equal(
    nextRunAfter(true, "10:30", after),
    new Date(2030, 0, 2, 10, 30).toISOString(),
  );
  assert.equal(
    nextRunAfter(true, "10:31", after),
    new Date(2030, 0, 1, 10, 31).toISOString(),
  );
  assert.equal(
    nextRunAfter(true, "10:29", after),
    new Date(2030, 0, 2, 10, 29).toISOString(),
  );
  // 一次性时间不受 after 限制，且纯函数不得改变传入的 Date。
  assert.equal(
    nextRunAfter(false, "2029-01-01T00:00:00.000Z", after),
    "2029-01-01T00:00:00.000Z",
  );
  assert.equal(after.getTime(), new Date(2030, 0, 1, 10, 30).getTime());
});

test("reconcileOnStart follows nanobot restart semantics", async (t) => {
  const { managed, repository } = await tempDatabase(t);
  const service = createJobService(repository);
  const now = new Date(2030, 0, 5, 10, 30);
  t.mock.timers.enable({ apis: ["Date"], now: now.getTime() });
  const daily: Job = {
    ...baseJob("daily"),
    daily: true,
    at: "10:30",
    nextRunAt: new Date(0).toISOString(),
  };
  const expired: Job = { ...baseJob("expired"), at: now.toISOString(), nextRunAt: now.toISOString() };
  const future: Job = {
    ...baseJob("future"),
    at: new Date(Date.now() + 60_000).toISOString(),
    nextRunAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const staleFuture = { ...future, id: "stale-future", nextRunAt: new Date(0).toISOString() };
  const disabled = { ...daily, id: "cancelled", enabled: false };
  const completed = { ...expired, id: "completed", enabled: false, lastStatus: "completed" as const };
  await repository.update(() => ({
    items: [daily, expired, future, staleFuture, disabled, completed], result: undefined,
  }));
  await service.reconcileOnStart();
  const jobs = await service.list();
  assert.deepEqual(jobs, [
    { ...daily, nextRunAt: new Date(2030, 0, 6, 10, 30).toISOString() },
    { ...expired, enabled: false },
    future,
    { ...staleFuture, nextRunAt: future.at },
    disabled,
    completed,
  ]);
  assert.ok(totalChanges(managed) > 0);
});

test("reconcileOnStart does not write when nothing changed", async (t) => {
  const { managed, repository } = await tempDatabase(t);
  const service = createJobService(repository);
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2029, 0, 1).getTime() });
  await service.reconcileOnStart();
  assert.deepEqual(await service.list(), []);
  const before = totalChanges(managed);
  await repository.update(() => ({ items: [baseJob("future")], result: undefined }));
  await service.reconcileOnStart();
  // 存量任务本身合法且无需重排时，不得产生任何写入。
  assert.equal(totalChanges(managed), before + 1);
  assert.deepEqual((await service.list()).map((job) => job.id), ["future"]);
});

test("reconcileOnStart rejects damaged jobs without replacing the original row", async (t) => {
  const { managed, repository } = await tempDatabase(t);
  // 绕过库内 CHECK 写入非法时刻：读取与启动排期都必须拒绝，坏行原样保留。
  managed.database.exec("PRAGMA ignore_check_constraints = ON");
  managed.database.prepare(
    "INSERT INTO jobs (id, position, prompt, daily, at, enabled, created_at, next_run_at) VALUES ('broken', 0, 'p', 1, '99:99', 1, ?, ?)",
  ).run("2029-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z");
  managed.database.exec("PRAGMA ignore_check_constraints = OFF");
  await assert.rejects(createJobService(repository).reconcileOnStart());
  const rows = managed.database.prepare("SELECT id, at FROM jobs").all() as Array<{ id: string; at: string }>;
  assert.deepEqual(rows.map((row) => ({ id: row.id, at: row.at })), [{ id: "broken", at: "99:99" }]);
});

test("nextRunAfter rejects invalid daily time without fallback or Date auto-overflow", () => {
  const after = new Date(2030, 0, 1, 10, 30);
  const isScheduleError = (err: unknown) =>
    err instanceof Error && "code" in err && (err as { code: string }).code === "INVALID_SCHEDULE_FORMAT";
  assert.throws(() => nextRunAfter(true, "invalid", after), isScheduleError);
  assert.throws(() => nextRunAfter(true, "25:75", after), isScheduleError);
  assert.throws(() => nextRunAfter(true, "09:99", after), isScheduleError);
  assert.throws(() => nextRunAfter(true, "24:00", after), isScheduleError);
  assert.throws(() => nextRunAfter(true, "9:00", after), isScheduleError);
  assert.throws(() => nextRunAfter(false, "invalid", after), isScheduleError);
  assert.throws(() => nextRunAfter(true, "Infinity:00", after), isScheduleError);
});

test("repository rejects bad job entries instead of filtering and keeps the original row", async (t) => {
  const { managed, repository } = await tempDatabase(t);
  // 绕过库内 CHECK 造出各类坏记录：布尔列不是 0/1、时间不是合法时刻、下一轮时间不可解析。
  const broken: Array<{ id: string; daily: string | number; at: string; nextRunAt: string }> = [
    { id: "bad-daily", daily: "yes", at: "2030-01-01T00:00:00.000Z", nextRunAt: "2030-01-01T00:00:00.000Z" },
    { id: "bad-at", daily: 0, at: "not-a-date", nextRunAt: "2030-01-01T00:00:00.000Z" },
    { id: "bad-next", daily: 0, at: "2030-01-01T00:00:00.000Z", nextRunAt: "invalid" },
  ];
  for (const [index, item] of broken.entries()) {
    managed.database.exec("PRAGMA ignore_check_constraints = ON");
    managed.database.prepare(
      "INSERT INTO jobs (id, position, prompt, daily, at, enabled, created_at, next_run_at) VALUES (?, 0, 'p', ?, ?, 1, ?, ?)",
    ).run(item.id, item.daily, item.at, "2029-01-01T00:00:00.000Z", item.nextRunAt);
    managed.database.exec("PRAGMA ignore_check_constraints = OFF");
    await assert.rejects(repository.read(), /Invalid jobs document/);
    await assert.rejects(repository.update(() => ({ items: [], result: undefined })), /Invalid jobs document/);
    // 坏记录不被过滤，也不被删除。
    const rows = managed.database.prepare("SELECT id FROM jobs ORDER BY id").all() as Array<{ id: string }>;
    assert.deepEqual(rows.map((row) => row.id).sort(), broken.slice(0, index + 1).map((entry) => entry.id).sort());
  }
});

test("add trims prompt and persists the task to the database", async (t) => {
  const { file, repository } = await tempDatabase(t);
  const service = createJobService(repository);

  const job = await service.add("  hello  ", false, "2030-01-01T00:00:00.000Z");
  assert.equal(job.prompt, "hello");
  assert.equal(job.enabled, true);
  assert.equal(job.daily, false);
  assert.equal(job.nextRunAt, job.at);
  assert.deepEqual(await service.list(), [job]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("markRun advances daily jobs, closes one-time jobs, and truncates results", async (t) => {
  const created = new Date(2030, 0, 1, 10, 30);
  t.mock.timers.enable({ apis: ["Date"], now: created.getTime() });
  const { repository } = await tempDatabase(t);
  const service = createJobService(repository);
  const daily = await service.add("daily", true, "23:59");
  const once = await service.add("once", false, "2030-01-01T00:00:00.000Z");
  const result = "x".repeat(2001);

  // 推进到原计划之后再结束任务，验证下一轮按结束时间而非旧 nextRunAt 计算。
  const reference = new Date(2030, 0, 2, 23, 59);
  t.mock.timers.setTime(reference.getTime());
  const dailyRun = await service.markRun(daily.id, "completed", result);
  const onceRun = await service.markRun(once.id, "failed", result);
  assert.equal(dailyRun?.lastResult?.length, 2000);
  assert.equal(dailyRun?.enabled, true);
  assert.equal(dailyRun?.lastStatus, "completed");
  assert.equal(dailyRun?.lastRunAt, reference.toISOString());
  assert.equal(dailyRun?.nextRunAt, nextRunAfter(true, daily.at, reference));
  assert.notEqual(dailyRun?.nextRunAt, daily.nextRunAt);
  assert.equal(onceRun?.lastResult?.length, 2000);
  assert.equal(onceRun?.enabled, false);
  assert.equal(onceRun?.lastStatus, "failed");
  assert.equal(onceRun?.lastRunAt, reference.toISOString());
  assert.equal(onceRun?.nextRunAt, once.nextRunAt);
  assert.equal(onceRun?.lastResult, result.slice(0, 2000));
  assert.deepEqual(await service.list(), [dailyRun, onceRun]);
  // 失败的每日任务仍推进下一轮；取消后 markRun 不重新启用它。
  await service.cancel(daily.id);
  const failedDaily = await service.markRun(daily.id, "failed", "short");
  assert.equal(failedDaily?.enabled, false);
  assert.equal(failedDaily?.lastStatus, "failed");
  assert.equal(failedDaily?.lastResult, "short");
  assert.equal(failedDaily?.nextRunAt, nextRunAfter(true, daily.at, reference));
});

test("markRun uses the supplied completion time even when saving on a later day", async (t) => {
  const completedAt = new Date(2030, 0, 1, 10, 31);
  t.mock.timers.enable({ apis: ["Date"], now: completedAt.getTime() });
  const { repository } = await tempDatabase(t);
  const service = createJobService(repository);
  const daily = await service.add("daily", true, "10:30");
  const once = await service.add("once", false, "2030-01-01T00:00:00.000Z");

  // 跨日补写必须沿用实际结束时刻，不能把 lastRunAt 或下一轮推到存储恢复日。
  t.mock.timers.setTime(new Date(2030, 0, 5, 12).getTime());
  const dailyRun = await service.markRun(daily.id, "completed", "daily done", completedAt);
  const onceRun = await service.markRun(once.id, "failed", "once failed", completedAt);
  assert.equal(dailyRun?.lastRunAt, completedAt.toISOString());
  assert.equal(dailyRun?.nextRunAt, new Date(2030, 0, 2, 10, 30).toISOString());
  assert.equal(dailyRun?.enabled, true);
  assert.equal(onceRun?.lastRunAt, completedAt.toISOString());
  assert.equal(onceRun?.nextRunAt, once.nextRunAt);
  assert.equal(onceRun?.enabled, false);
  assert.equal(completedAt.getTime(), new Date(2030, 0, 1, 10, 31).getTime());
  assert.deepEqual(await service.list(), [dailyRun, onceRun]);
});

test("markRun retry keeps a daily job cancelled after its first save failed", async (t) => {
  const completedAt = new Date(2030, 0, 1, 10, 31);
  t.mock.timers.enable({ apis: ["Date"], now: completedAt.getTime() });
  const { managed, repository } = await tempDatabase(t);
  const service = createJobService(repository);
  const daily = await service.add("cancel during retry", true, "10:30");
  const before = totalChanges(managed);
  const failedUpdate = t.mock.method(repository, "update", async () => {
    throw new Error("test save failure");
  });
  await assert.rejects(service.markRun(daily.id, "completed", "original result", completedAt));
  failedUpdate.mock.restore();
  assert.equal(totalChanges(managed), before);

  // 模型已经结束但结果尚未保存时，取消仍通过同一 repository 生效。
  // 补写只重算运行字段，不能拿执行前快照覆盖 enabled，也不能更改完成时间。
  assert.equal(await service.cancel(daily.id), true);
  t.mock.timers.setTime(new Date(2030, 0, 5, 12).getTime());
  const retried = await service.markRun(daily.id, "completed", "original result", completedAt);
  assert.equal(retried?.enabled, false);
  assert.equal(retried?.lastStatus, "completed");
  assert.equal(retried?.lastResult, "original result");
  assert.equal(retried?.lastRunAt, completedAt.toISOString());
  assert.equal(retried?.nextRunAt, new Date(2030, 0, 2, 10, 30).toISOString());
  assert.deepEqual(await service.list(), [retried]);
});

test("cancel disables an existing job", async (t) => {
  const { repository } = await tempDatabase(t);
  const service = createJobService(repository);
  const job = await service.add("cancel me", false, "2030-01-01T00:00:00.000Z");

  assert.equal(await service.cancel(job.id), true);
  const cancelled = await service.get(job.id);
  assert.equal(cancelled?.lastControl?.action, "cancel");
  assert.ok(Number.isFinite(Date.parse(cancelled!.lastControl!.at)));
  assert.deepEqual(await service.list(), [{ ...job, enabled: false, controlState: "cancelled", lastControl: cancelled!.lastControl }]);
  assert.equal(job.enabled, true);
  assert.equal(await service.cancel(job.id), true);
});

test("重复 id 无法入库，控制与执行只作用于唯一任务", async (t) => {
  const { managed, repository } = await tempDatabase(t);
  const service = createJobService(repository);
  const first = baseJob("duplicate");
  const second = { ...first, prompt: "second duplicate" };
  managed.database.prepare(
    "INSERT INTO jobs (id, position, prompt, daily, at, enabled, created_at, next_run_at, origin_session_id) VALUES (?, 0, ?, 0, ?, 1, ?, ?, ?)",
  ).run(first.id, first.prompt, first.at, first.createdAt, first.nextRunAt, first.originSessionId ?? null);
  // 同一 id 不再允许出现第二次：库内主键直接拒绝，旧文档里的重复行不再可能存在。
  assert.throws(() => managed.database.prepare(
    "INSERT INTO jobs (id, position, prompt, daily, at, enabled, created_at, next_run_at) VALUES (?, 1, ?, 0, ?, 1, ?, ?)",
  ).run(second.id, second.prompt, second.at, second.createdAt, second.nextRunAt), /UNIQUE constraint failed/);

  assert.equal(await service.cancel(first.id), true);
  const cancelledFirst = await service.get(first.id);
  assert.deepEqual(await service.list(), [{ ...first, enabled: false, controlState: "cancelled", lastControl: cancelledFirst!.lastControl }]);
  const run = await service.markRun(first.id, "completed", "first only");
  assert.equal(run?.lastResult, "first only");
  assert.deepEqual(await service.list(), [run]);
});

test("concurrent updates are serialized without losing jobs", async (t) => {
  const { repository } = await tempDatabase(t);
  const service = createJobService(repository);

  const jobs = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      service.add(`job-${index}`, false, "2030-01-01T00:00:00.000Z"),
    ),
  );
  assert.equal(jobs.length, 20);
  assert.deepEqual(await service.list(), jobs);
  // add/cancel/markRun 必须共用完整读改写队列，混合并发也不能覆盖其他结果。
  const [cancelled, marked, added] = await Promise.all([
    service.cancel(jobs[0].id),
    service.markRun(jobs[1].id, "completed", "done"),
    service.add("last", false, "2030-01-01T00:00:00.000Z"),
  ]);
  assert.equal(cancelled, true);
  const stored = await service.list();
  assert.equal(stored[0].lastControl?.action, "cancel");
  assert.deepEqual(stored, [
    { ...jobs[0], enabled: false, controlState: "cancelled", lastControl: stored[0].lastControl }, marked, ...jobs.slice(2), added,
  ]);
});

test("missing cancel and markRun do not write to the database", async (t) => {
  const { managed, repository } = await tempDatabase(t);
  const service = createJobService(repository);

  assert.equal(await service.cancel("missing"), false);
  assert.equal(await service.markRun("missing", "failed", "ignored"), undefined);
  assert.deepEqual(await service.list(), []);

  // 已有任务时，未命中同样不产生任何写入。
  await repository.update(() => ({ items: [baseJob("existing")], result: undefined }));
  const before = totalChanges(managed);
  assert.equal(await service.cancel("missing"), false);
  assert.equal(await service.markRun("missing", "completed", "ignored"), undefined);
  assert.equal(totalChanges(managed), before);
  assert.deepEqual((await service.list()).map((job) => job.id), ["existing"]);
});

test("repository writes returned empty arrays and recovers after a failed update", async (t) => {
  const { repository } = await tempDatabase(t);
  await assert.rejects(repository.update(() => { throw new Error("change failed"); }));
  assert.equal(await repository.update(() => ({ items: [], result: "cleared" })), "cleared");
  assert.deepEqual(await repository.read(), []);
});

test("update modifies job fields, records updatedAt and recalculates nextRunAt", async (t) => {
  const { repository } = await tempDatabase(t);
  const service = createJobService(repository);
  const job = await service.add("original prompt", true, "10:00");
  assert.equal(job.updatedAt, undefined);

  assert.equal(await service.update("missing", { prompt: "foo" }), undefined);

  const updated = await service.update(job.id, { prompt: "new prompt", at: "14:30" });
  assert.ok(updated);
  assert.equal(updated.prompt, "new prompt");
  assert.equal(updated.at, "14:30");
  assert.ok(updated.updatedAt && Number.isFinite(Date.parse(updated.updatedAt)));
  assert.ok(new Date(updated.updatedAt).getTime() >= new Date(job.createdAt).getTime());

  const stored = await service.get(job.id);
  assert.deepEqual(stored, updated);
});

test("JobService add, update, and reconcileOnStart strictly reject invalid daily time and keep data intact", async (t) => {
  const { repository } = await tempDatabase(t);
  const service = createJobService(repository);
  const isScheduleError = (err: unknown) =>
    err instanceof Error && "code" in err && (err as { code: string }).code === "INVALID_SCHEDULE_FORMAT";

  // 1. add 拒绝非法时刻
  for (const badTime of ["09:99", "24:00", "9:00", "invalid", "", "25:00"]) {
    await assert.rejects(
      () => service.add("test bad daily", true, badTime),
      isScheduleError,
    );
  }
  // 库里仍为空
  assert.deepEqual(await service.list(), []);

  // 2. 正常添加任务（包含 paused 任务）
  const job = await service.add("valid daily", true, "10:30");
  await service.control(job.id, "pause");
  const paused = await service.get(job.id);
  assert.equal(paused?.controlState, "paused");
  assert.equal(paused?.enabled, false);

  // 3. 对暂停/停用任务 update 非法时刻，也必须拒绝
  for (const badTime of ["09:99", "24:00", "9:00", "invalid"]) {
    await assert.rejects(
      () => service.update(job.id, { at: badTime }),
      isScheduleError,
    );
  }
  // 任务状态与时刻保持原样
  const unchanged = await service.get(job.id);
  assert.equal(unchanged?.at, "10:30");
  assert.equal(unchanged?.controlState, "paused");

  // 4. 合法边界 00:00 与 23:59 update 成功
  const updated00 = await service.update(job.id, { at: "00:00" });
  assert.equal(updated00?.at, "00:00");
  const updated2359 = await service.update(job.id, { at: "23:59" });
  assert.equal(updated2359?.at, "23:59");
});

test("reconcileOnStart strictly validates existing records (including disabled) and keeps the bad row untouched", async (t) => {
  const { managed, repository } = await tempDatabase(t);
  const service = createJobService(repository);

  // 写入包含非法时刻的停用任务
  managed.database.exec("PRAGMA ignore_check_constraints = ON");
  managed.database.prepare(
    "INSERT INTO jobs (id, position, prompt, daily, at, enabled, created_at, next_run_at, control_state) VALUES ('corrupt-disabled', 0, 'p', 1, '24:00', 0, ?, ?, 'paused')",
  ).run("2029-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z");
  managed.database.exec("PRAGMA ignore_check_constraints = OFF");

  // 确切断言：repository 读阶段由 jobs 文档规则拦截并抛出 InvalidDocumentError，绝不进位且坏行原样保留
  await assert.rejects(
    () => service.reconcileOnStart(),
    (err: unknown) => err instanceof Error && err.name === "InvalidDocumentError" && err.message.includes("jobs"),
  );

  // 坏行必须原样保留
  const rows = managed.database.prepare("SELECT id, at, enabled FROM jobs").all() as Array<{ id: string; at: string; enabled: number }>;
  assert.deepEqual(rows.map((row) => ({ id: row.id, at: row.at, enabled: row.enabled })), [
    { id: "corrupt-disabled", at: "24:00", enabled: 0 },
  ]);
});

test("a prior one-time completion records its result without consuming a newer schedule", async (t) => {
  const { repository } = await tempDatabase(t);
  const service = createJobService(repository);
  const job = await service.add("reminder", false, "2030-01-01T00:00:00.000Z");
  const at = "2030-01-02T00:00:00.000Z";
  await service.update(job.id, { at });
  const completedAt = new Date("2030-01-01T00:00:01.000Z");

  const result = (await service.markRun(job.id, "completed", "prior result", completedAt, job))!;
  assert.equal(result.enabled, true);
  assert.equal(result.nextRunAt, at);
  assert.equal(result.lastResult, "prior result");
  assert.equal(result.lastRunAt, completedAt.toISOString());
});
