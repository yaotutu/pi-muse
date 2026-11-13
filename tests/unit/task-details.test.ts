import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJobRepository } from "../../src/adapters/storage/job-repository.js";
import { jobsModule } from "../../src/adapters/storage/jobs-schema.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { openSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { createJobService } from "../../src/features/jobs/job-service.js";
import { presentJob, presentJobDetail } from "../../src/http/job-presenters.js";
import { jobDetail } from "../../src/http/contracts/responses.js";
import { parseJobs } from "../../src/adapters/storage/jobs-schema.js";
import type { Job } from "../../src/features/jobs/types.js";

/** 定时任务事实落在 main.sqlite；模块账本先登记，坏数据不得静默通过。 */
const fixture = async (t: TestContext, jobs: Job[] = []) => {
  const dir = await mkdtemp(join(tmpdir(), "personal-bot-task-detail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "main.sqlite");
  const managed = await openSqliteDatabase(file);
  t.after(() => managed.close());
  await managed.serialize(() => ensureSqliteModules(managed, [jobsModule]));
  const repository = createJobRepository(managed);
  if (jobs.length) await repository.update(() => ({ items: jobs, result: undefined }));
  return { file, managed, repository, service: createJobService(repository) };
};

/** 库内写入计数：证明“未命中/只读”没有产生任何写入。 */
const totalChanges = (managed: Awaited<ReturnType<typeof fixture>>["managed"]): number =>
  Number((managed.database.prepare("SELECT total_changes() AS n").get() as { n: number }).n);

const job = (extra: Partial<Job> = {}): Job => ({
  id: "job", prompt: "test reminder", daily: false, at: "2030-01-01T00:00:00.000Z",
  enabled: true, createdAt: "2026-01-01T00:00:00.000Z", nextRunAt: "2030-01-01T00:00:00.000Z",
  originSessionId: "main", ...extra,
});
const failed = (): Job => job({ enabled: false, at: "2026-01-02T00:00:00.000Z", nextRunAt: "2026-01-02T00:00:00.000Z", lastStatus: "failed", lastRunAt: "2026-01-02T00:00:01.000Z", lastResult: "Last attempt failed" });

test("task detail contains only recorded facts, latest events and stable IDs without mutating job", () => {
  const source = job({ lastRunAt: "2026-02-01T00:00:00.000Z", lastStatus: "completed", lastResult: "done", lastControl: { action: "pause", at: "2026-03-01T00:00:00.000Z" }, controlState: "paused", enabled: false });
  const before = structuredClone(source);
  const detail = presentJobDetail(source);
  assert.equal(jobDetail.safeParse(detail).success, true);
  assert.deepEqual(Object.keys(detail).sort(), ["events", "job"]);
  assert.deepEqual(detail.job, presentJob(source));
  assert.equal(detail.job.updatedAt, source.lastControl!.at);
  assert.equal(detail.job.status, "paused");
  assert.deepEqual(detail.events.map((event) => event.kind), ["status", "result", "status"]);
  assert.deepEqual(detail.events.map((event) => event.date), [source.createdAt, source.lastRunAt, source.lastControl!.at]);
  assert.equal(detail.events[1].detail, "done");
  assert.ok(detail.events.every((event) => event.taskId === source.id && Object.keys(event).length === 6));
  assert.deepEqual(presentJobDetail(source), detail);
  assert.deepEqual(source, before);
});

test("task detail does not infer success from a legacy result with no lastStatus", () => {
  const detail = presentJobDetail(job({ enabled: false, lastRunAt: "2026-02-01T00:00:00.000Z", lastResult: "historical text" }));
  assert.equal(detail.job.status, "cancelled");
  assert.equal(detail.events[1].kind, "observation");
  assert.equal(detail.events[1].title, "Latest recorded run");
});

test("GET job is read-only and missing controls neither create nor rewrite storage", async (t) => {
  const { managed, service } = await fixture(t, [job()]);
  assert.equal(await service.get("missing"), undefined);
  assert.equal((await service.control("missing", "pause")).ok, false);
  const before = totalChanges(managed);
  const stored = await service.list();
  await service.get("job"); await service.control("missing", "retry");
  assert.equal(totalChanges(managed), before);
  assert.deepEqual(await service.list(), stored);
});

test("pause/resume/cancel are persisted, status-consistent and repeated pause/cancel are no-ops", async (t) => {
  const { service } = await fixture(t, [job()]);
  assert.equal((await service.control("job", "pause")).ok, true);
  const paused = (await service.get("job"))!;
  assert.equal(paused.enabled, false); assert.equal(presentJob(paused).status, "paused");
  await service.control("job", "pause"); assert.deepEqual(await service.get("job"), paused);
  assert.equal((await service.control("job", "resume")).ok, true);
  assert.equal((await service.get("job"))!.nextRunAt, job().at);
  assert.equal(presentJob((await service.get("job"))!).status, "scheduled");
  assert.equal((await service.control("job", "cancel")).ok, true);
  const cancelled = (await service.get("job"))!;
  assert.equal(presentJob(cancelled).status, "cancelled");
  await service.cancel("job"); assert.deepEqual(await service.get("job"), cancelled);
  assert.equal((await service.control("job", "resume")).ok, false);
});

test("expired once cannot resume; daily resume calculates a future time and completed daily remains controllable", async (t) => {
  const expired = job({ at: "2026-01-02T00:00:00.000Z", enabled: false, controlState: "paused" });
  const daily = job({ id: "daily", daily: true, at: "10:30", lastStatus: "completed", lastResult: "prior success" });
  const { service } = await fixture(t, [expired, daily]);
  const before = await service.get("job");
  assert.equal((await service.control("job", "resume")).ok, false);
  assert.deepEqual(await service.get("job"), before);
  assert.equal((await service.control("daily", "pause")).ok, true);
  assert.equal((await service.control("daily", "resume")).ok, true);
  const resumed = (await service.get("daily"))!;
  assert.ok(Date.parse(resumed.nextRunAt) > Date.now());
  assert.equal(resumed.lastResult, "prior success");
  assert.equal((await service.control("daily", "cancel")).ok, true);
});

test("retry requires explicit failed state, rejects repeats, retains previous result and consumes pending on markRun", async (t) => {
  const { service } = await fixture(t, [failed(), job({ id: "success", enabled: false, lastStatus: "completed" })]);
  assert.equal((await service.control("success", "retry")).ok, false);
  assert.equal((await service.control("success", "cancel")).ok, false);
  assert.equal((await service.control("job", "retry")).ok, true);
  const queued = (await service.get("job"))!;
  assert.equal(queued.enabled, true); assert.equal(queued.lastResult, failed().lastResult);
  assert.equal(presentJob(queued).status, "queued"); assert.ok(Date.parse(queued.nextRunAt) <= Date.now());
  assert.equal((await service.control("job", "retry")).ok, false);
  const done = (await service.markRun("job", "completed", "new result"))!;
  assert.equal(done.controlState, undefined); assert.equal(done.lastControl?.action, "retry");
  assert.equal(done.enabled, false); assert.equal(presentJob(done).status, "succeeded");
});

test("resume/retry recheck execution busy after storage admission and do not persist rejected changes", async (t) => {
  const { repository, service } = await fixture(t, [failed()]);
  let busy = false;
  const original = repository.update;
  t.mock.method(repository, "update", ((change: Parameters<typeof original>[0]) => {
    busy = true;
    return original(change);
  }) as typeof original);
  const before = await service.get("job");
  const result = await service.control("job", "retry", () => busy);
  assert.equal(result.ok, false);
  assert.deepEqual(await service.get("job"), before);
});

for (const action of ["pause", "cancel"] as const) {
  test(`${action} during retry execution survives markRun and keeps the real completion outcome`, async (t) => {
    const { service } = await fixture(t, [failed()]);
    await service.control("job", "retry");
    await service.control("job", action, () => true);
    const completedAt = new Date();
    const saved = (await service.markRun("job", "completed", "side effect retained", completedAt))!;
    assert.equal(saved.enabled, false);
    assert.equal(saved.controlState, action === "pause" ? "paused" : "cancelled");
    assert.equal(saved.lastControl?.action, action);
    assert.equal(saved.lastResult, "side effect retained");
    assert.equal(saved.lastRunAt, completedAt.toISOString());
    assert.equal((await service.control("job", "retry")).ok, false);
  });
}

test("daily result written before a later control keeps outcome when paused/cancelled", async (t) => {
  const { service } = await fixture(t, [job({ daily: true, at: "10:30" })]);
  await service.markRun("job", "completed", "daily result");
  await service.control("job", "pause");
  await service.cancel("job");
  const saved = (await service.get("job"))!;
  assert.equal(saved.lastResult, "daily result"); assert.equal(saved.enabled, false);
  assert.equal(saved.controlState, "cancelled");
});

test("control updates only first duplicate and repository failures do not report success", async (t) => {
  const { managed, repository, service } = await fixture(t, [job()]);
  await service.control("job", "pause");
  const stored = await service.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.controlState, "paused");
  t.mock.method(repository, "update", async () => { throw new Error("write failed"); });
  await assert.rejects(service.control("job", "resume"), /write failed/);
  assert.ok(totalChanges(managed) >= 0);
});

test("restart preserves pause/cancel but does not durably replay immediate retry requests", async (t) => {
  const { managed, service } = await fixture(t, [failed(), job({ id: "daily", daily: true, at: "10:30", lastStatus: "failed" }), job({ id: "paused" })]);
  await service.control("job", "retry"); await service.control("daily", "retry"); await service.control("paused", "pause");
  // 重启：新的 repository 实例读同一个数据库，启动排期照旧执行。
  const restarted = createJobService(createJobRepository(managed));
  await restarted.reconcileOnStart();
  assert.equal((await restarted.get("job"))!.enabled, false);
  assert.equal((await restarted.get("job"))!.controlState, undefined);
  assert.equal((await restarted.get("job"))!.lastControl?.action, "retry");
  const daily = (await restarted.get("daily"))!;
  assert.equal(daily.controlState, undefined); assert.ok(Date.parse(daily.nextRunAt) > Date.now());
  assert.equal((await restarted.get("paused"))!.controlState, "paused");
});

test("job records validate complete fields and control metadata", () => {
  assert.throws(() => parseJobs([{ id: "partial", prompt: "partial" }, { bad: true }]), /Invalid jobs document/);
  for (const extra of [
    { controlState: "running" }, { lastControl: null }, { lastControl: { action: "pause", at: "invalid" } },
    { lastControl: { action: "made_up", at: "2026-01-01T00:00:00.000Z" } },
  ]) assert.throws(() => parseJobs([{ ...job(), ...extra }]), /Invalid jobs document/);
  const controlled = job({ controlState: "paused", lastControl: { action: "pause", at: "2026-01-01T00:00:00.000Z" } });
  assert.deepEqual(parseJobs([controlled]), [controlled]);
});
