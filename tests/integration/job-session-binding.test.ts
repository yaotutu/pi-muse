import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createService } from "../../src/bootstrap/create-service.js";
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

const fixture = async (t: TestContext) => {
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
    runtime: { dataDir: dir, runTimeoutMs: 5000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
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

  return { dir, model, service: () => service!, request, snapshot, listed, releaseGates };
};

test("existing job rebound to a valid new originSessionId creates target agent and runs in that agent", async (t) => {
  const h = await fixture(t);
  const initialJob = await h.service().jobs.add("test rebound prompt", false, "2030-01-01T00:00:00.000Z", "main");
  const missingId = "00000000-0000-4000-8000-000000000001";
  assert.equal(await h.listed(missingId), false);
  const missing = await h.request(`/api/jobs/${initialJob.id}`, "PATCH", { originSessionId:missingId });
  assert.equal(missing.status,404,"binding may not create a missing public session");
  const targetSessionId = (await h.service().sessions.create("rebound-target")).id;

  assert.equal(await h.listed(targetSessionId), true);

  const modelCallsBefore = h.model.requests.length;

  const patchResp = await h.request(`/api/jobs/${initialJob.id}`, "PATCH", {
    originSessionId: targetSessionId,
  });
  assert.equal(patchResp.status, 200);
  const patchedJob = await patchResp.json() as { id: string; originSessionId?: string };
  assert.equal(patchedJob.originSessionId, targetSessionId);

  // 1. 真实智能体列表与 sessions 目录已建立
  assert.equal(await h.listed(targetSessionId), true);
  const targetDirStat = await stat(join(h.dir, "sessions", targetSessionId));
  assert.ok(targetDirStat.isDirectory());

  // 再改绑已存在智能体也成功
  const secondPatch = await h.request(`/api/jobs/${initialJob.id}`, "PATCH", {
    originSessionId: targetSessionId,
  });
  assert.equal(secondPatch.status, 200);

  // 调度器触发该任务，等待 jobs.get(id).lastStatus === "completed"
  const pastIso = new Date(Date.now() - 1000).toISOString();
  await h.service().jobs.update(initialJob.id, { at: pastIso });
  const scheduler = createScheduler(
    { schedulerIntervalMs: 10 },
    h.service().jobs,
    await h.service().conversationHub.forSession("main"),
    (id) => h.service().conversationHub.findSession(id),
  );
  scheduler.start();
  try {
    await until(async () => {
      const stored = await h.service().jobs.get(initialJob.id);
      return stored?.lastStatus === "completed";
    });

    // 目标智能体历史中包含 assistant 的 JOB-RAN 输出
    const targetSnap = await h.snapshot(targetSessionId);
    assert.ok(
      targetSnap.messages.some(
        (m) => m.role === "assistant" && m.content?.includes("JOB-RAN") && m.content?.includes("test rebound prompt"),
      ),
      "target agent history must include assistant JOB-RAN reply",
    );

    // 本地 provider 发生调用
    assert.ok(h.model.requests.length > modelCallsBefore, "model requests count must increase");

    // 主智能体无误投
    const mainSnap = await h.snapshot("main");
    assert.equal(mainSnap.messages.some((m) => m.content?.includes("test rebound prompt")), false);
  } finally {
    await scheduler.close();
  }
});

test("omitting originSessionId on update preserves existing originSessionId and does not open extra agents", async (t) => {
  const h = await fixture(t);
  const targetSessionId = (await h.service().sessions.create("custom-origin")).id;
  // 先通过 explicit withSession 建立智能体并添加任务
  await h.service().conversationHub.withSession(targetSessionId, async () => undefined);
  const job = await h.service().jobs.add("prompt to preserve", false, "2030-01-01T00:00:00.000Z", targetSessionId);

  // 捕获更新前的智能体列表与 sessions 目录集合
  const beforeAgentsResp = await h.request("/api/sessions");
  const beforeAgents = ((await beforeAgentsResp.json()) as { sessions?: { id: string }[] }).sessions?.map((s) => s.id).sort();
  const beforeDirs = (await readdir(join(h.dir, "sessions"))).sort();

  // 监听 withSession 调用次数
  let withSessionCalls = 0;
  const originalWithAgent = h.service().conversationHub.withSession;
  h.service().conversationHub.withSession = async (...args) => {
    withSessionCalls++;
    return originalWithAgent(...args);
  };
  try {
    const patchResp = await h.request(`/api/jobs/${job.id}`, "PATCH", {
      prompt: "updated prompt text",
    });
    assert.equal(patchResp.status, 200);
    const patchedJob = await patchResp.json() as { id: string; prompt: string; originSessionId?: string };
    assert.equal(patchedJob.prompt, "updated prompt text");
    assert.equal(patchedJob.originSessionId, targetSessionId);

    // 验证 withSession 调用为零，原绑定不变
    assert.equal(withSessionCalls, 0, "withSession must not be called when originSessionId is omitted");

    // 智能体列表与 sessions 目录前后完全一致，没有打开或创建任何额外智能体
    const afterAgentsResp = await h.request("/api/sessions");
    const afterAgents = ((await afterAgentsResp.json()) as { sessions?: { id: string }[] }).sessions?.map((s) => s.id).sort();
    const afterDirs = (await readdir(join(h.dir, "sessions"))).sort();

    assert.deepEqual(afterAgents, beforeAgents);
    assert.deepEqual(afterDirs, beforeDirs);
  } finally {
    h.service().conversationHub.withSession = originalWithAgent;
  }
});

test("invalid schedule format, bad input or missing job is rejected before creating target agent", async (t) => {
  const h = await fixture(t);
  const nonExistentAgent = "00000000-0000-4000-8000-000000000099";

  // 1. 任务不存在 404，不创建智能体
  const missingJobResp = await h.request("/api/jobs/missing-id", "PATCH", {
    originSessionId: nonExistentAgent,
  });
  assert.equal(missingJobResp.status, 404);
  assert.equal(await h.listed(nonExistentAgent), false);
  await assertMissing(join(h.dir, "sessions", nonExistentAgent));

  // 2. 存在任务，但更新 payload 无效（如非法时刻格式）400，不创建智能体
  const job = await h.service().jobs.add("valid prompt", false, "2030-01-01T00:00:00.000Z", "main");
  const badScheduleResp = await h.request(`/api/jobs/${job.id}`, "PATCH", {
    daily: true,
    at: "invalid-hh-mm",
    originSessionId: nonExistentAgent,
  });
  assert.equal(badScheduleResp.status, 400);
  assert.equal(await h.listed(nonExistentAgent), false);
  await assertMissing(join(h.dir, "sessions", nonExistentAgent));

  // 3. 非法 originSessionId 400
  const badSessionIdResp = await h.request(`/api/jobs/${job.id}`, "PATCH", {
    originSessionId: "invalid agent name with agents",
  });
  assert.equal(badSessionIdResp.status, 400);
});

test("deterministic gate: PATCH returns 409 SESSION_DELETING while target agent is being deleted, job remains unchanged and no resurrection occurs", async (t) => {
  const h = await fixture(t);
  const targetSessionId = (await h.service().sessions.create("agent-to-delete")).id;
  await h.service().conversationHub.withSession(targetSessionId, async () => undefined);
  assert.equal(await h.listed(targetSessionId), true);

  const job = await h.service().jobs.add("prompt original", false, "2030-01-01T00:00:00.000Z", "main");

  const deleteEntered = deferred();
  const deleteProceed = deferred();
  const originalRemoveJobs = h.service().jobs.removeByOriginSessionId;
  h.service().jobs.removeByOriginSessionId = async (origin) => {
    deleteEntered.resolve();
    await waitGate(deleteProceed.promise, t.signal);
    return originalRemoveJobs(origin);
  };
  h.releaseGates.push(deleteProceed.resolve);

  // 开始删除 targetSessionId
  const deleteReq = h.request(`/api/sessions/${targetSessionId}`, "DELETE");
  await waitGate(deleteEntered.promise, t.signal);

  // 删除进行中，尝试将任务改绑到该智能体 -> 必须返回 409 SESSION_DELETING
  const patchResp = await h.request(`/api/jobs/${job.id}`, "PATCH", {
    originSessionId: targetSessionId,
  });
  assert.equal(patchResp.status, 409);
  const patchBody = await patchResp.json() as { code?: string; error?: string };
  assert.equal(patchBody.code, "SESSION_DELETING");

  // 原任务及其归属不变
  const currentJob = await h.service().jobs.get(job.id);
  assert.equal(currentJob?.originSessionId, "main");

  // 放行删除完成
  deleteProceed.resolve();
  assert.equal((await deleteReq).status, 200);
  h.service().jobs.removeByOriginSessionId = originalRemoveJobs;

  // 删除完成后无目标智能体复活，原任务仍属 main
  assert.equal(await h.listed(targetSessionId), false);
  await assertMissing(join(h.dir, "sessions", targetSessionId));
});

test("deterministic gate: rebinding enters withSession first, then DELETE starts; upon rebind completion DELETE cascades the job, directory does not resurrect", async (t) => {
  const h = await fixture(t);
  const targetSessionId = (await h.service().sessions.create("rebind-then-delete")).id;
  const job = await h.service().jobs.add("prompt to cascade", false, "2030-01-01T00:00:00.000Z", "main");

  const updateEntered = deferred();
  const updateProceed = deferred();
  const originalUpdate = h.service().jobs.update;
  h.service().jobs.update = async (...args) => {
    updateEntered.resolve();
    await waitGate(updateProceed.promise, t.signal);
    return originalUpdate(...args);
  };
  h.releaseGates.push(updateProceed.resolve);

  // 包裹 deleteSession，确保 DELETE 已进入服务端并同步设置了 deleting 门
  const deleteEntered = deferred();
  const originalDeleteAgent = h.service().conversationHub.deleteSession;
  h.service().conversationHub.deleteSession = ((id: string, remove: () => Promise<unknown>) => {
    const promise = originalDeleteAgent(id, remove);
    deleteEntered.resolve();
    return promise;
  }) as typeof originalDeleteAgent;

  let removeJobsCalled = false;
  const originalRemoveJobs = h.service().jobs.removeByOriginSessionId;
  h.service().jobs.removeByOriginSessionId = async (origin) => {
    removeJobsCalled = true;
    return originalRemoveJobs(origin);
  };

  try {
    // 发起改绑 PATCH，改绑会先进入 withSession 并挂起在 jobs.update
    const patchReq = h.request(`/api/jobs/${job.id}`, "PATCH", {
      originSessionId: targetSessionId,
    });
    await waitGate(updateEntered.promise, t.signal);

    // 发起 DELETE 该智能体
    const deleteReq = h.request(`/api/sessions/${targetSessionId}`, "DELETE");

    // 等待 DELETE 到达服务端并进入 deleteSession（deleting 门已设）
    await waitGate(deleteEntered.promise, t.signal);

    // 证明级联等待改绑：此时 withSession 尚未完成，deleteSession 内部排队等待，removeByOriginSessionId 尚未被调用
    assert.equal(removeJobsCalled, false, "removeByOriginSessionId must wait for in-flight withSession rebind");

    // 放行 jobs.update
    updateProceed.resolve();

    const [patchResp, deleteResp] = await Promise.all([patchReq, deleteReq]);
    assert.equal(patchResp.status, 200);
    assert.equal(deleteResp.status, 200);

    // 改绑完成后由于 deleteSession 紧接着执行，该任务被级联删除
    assert.equal(removeJobsCalled, true, "removeByOriginSessionId must be called during agent deletion");
    const jobAfterCascade = await h.service().jobs.get(job.id);
    assert.equal(jobAfterCascade, undefined);

    // 目录不复活
    assert.equal(await h.listed(targetSessionId), false);
    await assertMissing(join(h.dir, "sessions", targetSessionId));
  } finally {
    updateProceed.resolve();
    h.service().jobs.update = originalUpdate;
    h.service().jobs.removeByOriginSessionId = originalRemoveJobs;
    h.service().conversationHub.deleteSession = originalDeleteAgent;
  }
});

test("deterministic gate: in-flight stale scan snapshot cannot execute after origin agent is deleted", async (t) => {
  const h = await fixture(t);
  const targetSessionId = (await h.service().sessions.create("stale-scan-origin")).id;

  // 创建并改绑一个已到期任务到 targetSessionId
  const pastIso = new Date(Date.now() - 1000).toISOString();
  const job = await h.service().jobs.add("stale scan prompt", false, pastIso, "main");
  const patchResp = await h.request(`/api/jobs/${job.id}`, "PATCH", {
    originSessionId: targetSessionId,
  });
  assert.equal(patchResp.status, 200);
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
    const deleteResp = await h.request(`/api/sessions/${targetSessionId}`, "DELETE");
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
