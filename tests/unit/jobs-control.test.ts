import assert from "node:assert/strict";
import { test } from "node:test";
import { createJobsRoutes } from "../../src/http/routes/jobs.js";
import { createJobService } from "../../src/features/jobs/job-service.js";
import type { Job } from "../../src/features/jobs/types.js";
import type { JobRepository } from "../../src/features/jobs/ports.js";

test("POST /api/jobs/:id/control checks target agent running state, not hardcoded local-main", async () => {
  let items: Job[] = [];
  const repository: JobRepository = {
    read: async () => structuredClone(items),
    update: async <T>(change: (items: Job[]) => { items?: Job[]; result: T }) => {
      const changed = change(structuredClone(items));
      if (changed.items) items = changed.items;
      return changed.result;
    },
  };
  const jobs = createJobService(repository);

  // 创建一个归属于 agent-a 的 paused 任务
  const jobInAgentA = await jobs.add("task in agent a", true, "12:00", "agent-a");
  await jobs.control(jobInAgentA.id, "pause");
  assert.equal((await jobs.get(jobInAgentA.id))?.controlState, "paused");

  // 创建一个缺省归属 (local-main) 的 paused 任务
  const jobInMain = await jobs.add("task in main", true, "13:00", "local-main");
  await jobs.control(jobInMain.id, "pause");
  assert.equal((await jobs.get(jobInMain.id))?.controlState, "paused");

  let localMainRunning = false;
  let agentARunning = false;
  let schedulerBusy = false;

  const conversationHub = {
    forAgent: async (agentId: string) => ({
      isRunning: () => (agentId === "agent-a" ? agentARunning : localMainRunning),
      sessionId: () => `session-${agentId}`,
    }),
    withAgent: async (_agentId: string, fn: () => Promise<unknown>) => fn(),
  };
  const scheduler = {
    isBusy: () => schedulerBusy,
  };

  const app = createJobsRoutes({
    jobs,
    conversationHub: conversationHub as never,
    scheduler: scheduler as never,
  });

  // 1. local-main 正在运行聊天，但目标任务在 agent-a（agent-a 空闲）
  localMainRunning = true;
  agentARunning = false;
  schedulerBusy = false;

  // 控制 agent-a 任务 resume：应当成功（200），不被主智能体运行阻塞
  const res1 = await app.request(`/api/jobs/${jobInAgentA.id}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resume" }),
  });
  assert.equal(res1.status, 200);
  const body1 = await res1.json() as { id: string; controlState?: string; enabled: boolean };
  assert.equal(body1.enabled, true);
  assert.equal(body1.controlState, undefined);

  // 重新暂停 agent-a 任务准备下一阶段测试
  await jobs.control(jobInAgentA.id, "pause");

  // 2. agent-a 本身正在运行聊天，即使 local-main 空闲，也必须返回 409 冲突
  localMainRunning = false;
  agentARunning = true;
  schedulerBusy = false;

  const res2 = await app.request(`/api/jobs/${jobInAgentA.id}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resume" }),
  });
  assert.equal(res2.status, 409);
  const body2 = await res2.json() as { error: string };
  assert.match(body2.error, /Wait for the current response/);

  // 3. scheduler.isBusy() 为 true 时，两个智能体都应被阻塞
  localMainRunning = false;
  agentARunning = false;
  schedulerBusy = true;

  const res3 = await app.request(`/api/jobs/${jobInAgentA.id}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resume" }),
  });
  assert.equal(res3.status, 409);

  // 4. local-main 任务在 local-main 运行时 resume 返回 409
  localMainRunning = true;
  schedulerBusy = false;
  const res4 = await app.request(`/api/jobs/${jobInMain.id}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resume" }),
  });
  assert.equal(res4.status, 409);

  // 5. 不存在的任务返回 404
  const res5 = await app.request("/api/jobs/missing-job/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resume" }),
  });
  assert.equal(res5.status, 404);
});
