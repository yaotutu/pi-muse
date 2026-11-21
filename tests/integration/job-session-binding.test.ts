import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createService } from "../support/test-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";
import { createScheduler } from "../../src/features/jobs/scheduler.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const waitGate = async (promise: Promise<void>, signal: AbortSignal) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(new Error("test cancelled"));
      signal.addEventListener("abort", abort, {once:true});
      timer = setTimeout(() => reject(new Error("fixture gate timed out")), 4000);
    })]);
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
};

const until = async (condition: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
};

const assertMissing = async (path: string) => assert.rejects(stat(path), { code: "ENOENT" });

const fixture = async (t: TestContext, schedulerIntervalMs = 60000) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-job-binding-"));
  let model: Awaited<ReturnType<typeof createFakeModel>> | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  const releaseGates: (() => void)[] = [];

  const stop = async () => {
    for (const release of releaseGates) release();
    try { await service?.close(); } finally {
      if (server && "closeAllConnections" in server) server.closeAllConnections();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  };

  t.after(async () => {
    try { await stop(); } finally {
      try { await model?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });

  model = await createFakeModel();
  const config = createConfig({
    server: { host: "127.0.0.1" },
    model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "fake-test-key" },
    runtime: { dataDir: dir, runTimeoutMs: 5000, schedulerIntervalMs, monitorScanIntervalMs: 60000 },
  });

  service = await createService(config);
  server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const request = (path: string, method = "GET", body?: unknown) => fetch(baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${service!.auth.login()}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const snapshot = async (id: string) => {
    const response = await request(`/api/conversation?sessionId=${id}`);
    assert.equal(response.status, 200);
    return response.json() as Promise<{ messages: { role: string; content?: string }[]; revision: string }>;
  };

  const listed = async (id: string) => {
    const response = await request("/api/sessions");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { sessions?: { id: string }[] };
    return (body.sessions || []).some((agent: { id: string }) => agent.id === id);
  };

  const schedules = async (id: string) => {
    const response = await request(`/api/sessions/${id}/schedules`);
    assert.equal(response.status, 200);
    return response.json() as Promise<{ scheduleRevision: string; jobs: { id: string; title: string }[]; monitors: { id: string; title: string }[] }>;
  };
  const remove = async (id: string, scheduleDisposition: "delete" | "move-to-main" = "delete") =>
    request(`/api/sessions/${id}`, "DELETE", { scheduleDisposition, scheduleRevision: (await schedules(id)).scheduleRevision });
  return { dir, model, config, stop, service: () => service!, request, snapshot, listed, schedules, remove, releaseGates };

};

test("move-to-main preserves the original schedules and runs the task only in main", async (t) => {
  const h = await fixture(t);
  const { id } = await h.service().sessions.create("move-source");
  const at = "2030-01-01T00:00:00.000Z";
  const job = await h.service().jobs.add("test moved prompt", false, at, id);
  const monitor = await h.service().monitors.create({
    originSessionId: id, url: "https://example.com/", condition: "contains", value: "ALERT",
  });
  await h.service().monitors.check(monitor, { body: "ALERT" });
  await h.service().monitors.control(monitor.id, "pause");
  const monitorBefore = await h.service().monitors.get(monitor.id);

  assert.equal((await h.request(`/api/jobs/${job.id}`, "PATCH", { originSessionId: "main" })).status, 400);
  assert.equal((await h.request(`/api/monitors/${monitor.id}`, "PATCH", { originSessionId: "main" })).status, 400);
  assert.deepEqual((await h.schedules(id)).jobs, [{ id: job.id, title: job.prompt }]);
  const response = await h.remove(id, "move-to-main");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, removed: { sessions: 1, jobs: 0, monitors: 0 }, moved: { jobs: 1, monitors: 1 } });
  assert.deepEqual(await h.service().jobs.get(job.id), { ...job, originSessionId: "main" });
  assert.deepEqual(await h.service().monitors.get(monitor.id), { ...monitorBefore, originSessionId: "main" });
  assert.equal(await h.listed(id), false);
  await assertMissing(join(h.dir, "sessions", id));

  await h.service().jobs.update(job.id, { at: new Date(Date.now() - 1000).toISOString() });
  const scheduler = createScheduler(
    { schedulerIntervalMs: 10 }, h.service().jobs, await h.service().conversationHub.forSession("main"),
    (sessionId) => h.service().conversationHub.findSession(sessionId),
  );
  scheduler.start();
  try {
    await until(async () => (await h.service().jobs.get(job.id))?.lastStatus === "completed");
    assert.ok((await h.snapshot("main")).messages.some((message) =>
      message.role === "assistant" && message.content?.includes("test moved prompt")));
    assert.deepEqual((await h.snapshot(id)).messages, []);
  } finally { await scheduler.close(); }
});

test("schedule confirmation is rechecked after admitted creations and expires if the list changes", async (t) => {
  const h = await fixture(t);
  const { id } = await h.service().sessions.create("changed-schedules");
  const preview = await h.schedules(id);
  const newlyAdmitted = deferred();
  const allowCreation = deferred();
  h.releaseGates.push(allowCreation.resolve);
  const creating = h.service().conversationHub.withSession(id, async () => {
    newlyAdmitted.resolve();
    await waitGate(allowCreation.promise, t.signal);
    return h.service().jobs.add("new job after confirmation", false, "2030-01-01T00:00:00.000Z", id);
  });
  await newlyAdmitted.promise;
  const deleting = h.request(`/api/sessions/${id}`, "DELETE", { scheduleDisposition: "delete", scheduleRevision: preview.scheduleRevision });
  await until(async () => h.service().conversationHub.isDeleting(id));
  assert.equal((await h.request("/api/monitors", "POST", {
    originSessionId: id, url: "https://example.com/", condition: "change",
  })).status, 409);
  allowCreation.resolve();
  const job = await creating;
  const conflict = await deleting;
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "SESSION_SCHEDULES_CHANGED");
  assert.ok(await h.service().jobs.get(job.id));
  assert.equal(await h.listed(id), true);
  const removed = await h.remove(id);
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true, removed: { sessions: 1, jobs: 1, monitors: 0 }, moved: { jobs: 0, monitors: 0 } });
  assert.equal(await h.service().jobs.get(job.id), undefined);
});

test("retaining schedules waits for the source job, while delete cancels it", async (t) => {
  const h = await fixture(t, 10);
  const { id } = await h.service().sessions.create("running-job");
  const job = await h.service().jobs.add(
    'wait\n\nE2E activity {"calls":[],"end":"hold"}',
    false, new Date(Date.now() - 1000).toISOString(), id,
  );
  await until(async () => h.model.requests.length > 0 && h.service().scheduler.isRunningFor(id));
  const before = await h.schedules(id);
  const keep = await h.remove(id, "move-to-main");
  assert.equal(keep.status, 409);
  assert.equal((await keep.json()).code, "SESSION_JOB_RUNNING");
  assert.deepEqual(await h.schedules(id), before);
  assert.equal(h.service().scheduler.isRunningFor(id), true);
  assert.equal((await h.remove(id)).status, 200);
  await until(async () => !h.service().scheduler.isRunningFor(id));
  assert.equal(await h.service().jobs.get(job.id), undefined);
  assert.equal(await h.listed(id), false);
  assert.deepEqual((await h.snapshot("main")).messages, []);
});

test("startup completes a partially applied move without losing the schedule or resurrecting the old session", async (t) => {
  const h = await fixture(t);
  const { id } = await h.service().sessions.create("recover-move");
  const job = await h.service().jobs.add("retained job", false, "2030-01-01T00:00:00.000Z", id);
  const monitor = await h.service().monitors.create({ originSessionId: id, url: "https://example.com/", condition: "change" });
  h.service().monitors.moveByOriginSessionId = async () => { throw new Error("injected monitor write failure"); };
  const interrupted = await h.remove(id, "move-to-main");
  assert.equal(interrupted.status, 500);
  assert.equal((await h.service().jobs.get(job.id))?.originSessionId, "main");
  assert.equal((await h.service().monitors.get(monitor.id))?.originSessionId, id);
  assert.equal(h.service().sessions.isScheduleBlocked(job.id), true);
  assert.deepEqual((await h.snapshot(id)).messages, []);
  await h.stop();
  const reopened = await createService(h.config);
  try {
    assert.equal(await reopened.sessions.get(id), undefined);
    assert.equal((await reopened.jobs.get(job.id))?.originSessionId, "main");
    assert.equal((await reopened.monitors.get(monitor.id))?.originSessionId, "main");
    assert.equal(reopened.sessions.isScheduleBlocked(job.id), false);
    await assertMissing(join(h.dir, "sessions", id));
  } finally { await reopened.close(); }
});

test("deterministic gate: in-flight stale scan snapshot cannot execute after origin agent is deleted", async (t) => {
  const h = await fixture(t);
  const targetSessionId = (await h.service().sessions.create("stale-scan-origin")).id;

  const pastIso = new Date(Date.now() - 1000).toISOString();
  const job = await h.service().jobs.add("stale scan prompt", false, pastIso, targetSessionId);
  assert.equal(await h.listed(targetSessionId), true);

  const modelCallsBefore = h.model.requests.length;

  const resolutionEntered = deferred();
  const resolutionProceed = deferred();
  h.releaseGates.push(resolutionProceed.resolve);

  // 独立 scheduler：forSession 先取得真实的 conversation，但挂起在返回前
  let resolvedOnce = false;
  const scheduler = createScheduler(
    { schedulerIntervalMs: 10 },
    h.service().jobs,
    await h.service().conversationHub.forSession("main"),
    async (sessionId) => {
      const conv = await h.service().conversationHub.findSession(sessionId);
      if (sessionId === targetSessionId && !resolvedOnce) {
        resolvedOnce = true;
        resolutionEntered.resolve();
        await waitGate(resolutionProceed.promise, t.signal);
      }
      return conv;
    },
  );

  scheduler.start();
  try {
    // 等待 scheduler 扫描到该到期任务并进入 forSession 解析
    await waitGate(resolutionEntered.promise, t.signal);

    // 此时调度器持有该任务快照并已拿到 targetAgent 的 conversation，但在返回给调度器前挂起；
    // 发起真实 HTTP DELETE 删除该智能体并级联清理该任务
    const deleteResp = await h.remove(targetSessionId);
    assert.equal(deleteResp.status, 200);

    // 确认智能体已删除，任务已级联清理
    assert.equal(await h.service().jobs.get(job.id), undefined);
    assert.equal(await h.listed(targetSessionId), false);
    await assertMissing(join(h.dir, "sessions", targetSessionId));

    // 放行 forSession 返回刚才缓存的旧 conversation
    resolutionProceed.resolve();

    // 等待该 tick 真正结束（scheduler 变空闲）
    await until(async () => !scheduler.isBusy());

    // 验证：无新的 provider 请求、主智能体无消息、目标目录未复活、jobs 中仍无该项
    assert.equal(h.model.requests.length, modelCallsBefore, "no provider requests should be made for deleted origin");
    const mainSnap = await h.snapshot("main");
    assert.equal(mainSnap.messages.some((m) => m.content?.includes("stale scan prompt")), false);
    assert.equal(await h.listed(targetSessionId), false);
    await assertMissing(join(h.dir, "sessions", targetSessionId));
    assert.equal(await h.service().jobs.get(job.id), undefined);
  } finally {
    resolutionProceed.resolve();
    await scheduler.close();
  }
});
