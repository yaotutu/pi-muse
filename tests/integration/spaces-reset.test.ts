import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";

// 重置路由新增真实通信生命周期依赖；不再用缺字段的路由替身检查函数调用顺序。
test("space reset clears pending monitor delivery, preserves schedules by default and deletes only explicit source schedules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-reset-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const createdAt = new Date().toISOString();
  const at = new Date(Date.now() + 86400000).toISOString();
  await writeFile(join(root, "monitors.json"), JSON.stringify(["custom-space", "local-main"].map((originSpaceId) => ({
    id: `monitor-${originSpaceId}`, title: "Reset fixture", url: "https://example.com/", condition: "change", intervalMinutes: 30,
    status: "paused", createdAt, originSpaceId, checks: 1, pendingNotification: { id: `notification-${originSpaceId}`, summary: "Old pending delivery" },
  }))));
  await writeFile(join(root, "jobs.json"), JSON.stringify(["custom-space", "local-main"].map((originSpaceId) => ({
    id: `job-${originSpaceId}`, prompt: "Future reset fixture", daily: false, at, enabled: true, createdAt, nextRunAt: at, originSpaceId,
  }))));
  const service = await createService(createConfig({ server: { host: "127.0.0.1", accessKey: "reset-isolated-access" }, runtime: { dataDir: root }, tools: { browser: { enabled: false } } }));
  const http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  t.after(async () => {
    await service.close();
    if ("closeAllConnections" in http) http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  if (!http.listening) await once(http, "listening");
  const address = http.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const login = await fetch(baseUrl + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: "reset-isolated-access" }) });
  const { token } = await login.json();
  const request = async (path: string, body: unknown, method = "POST") => {
    const response = await fetch(baseUrl + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  await request("/api/spaces/custom-space/instructions", { instructions: "Reset test space" }, "PUT");
  for (const spaceId of ["custom-space", "local-main"]) {
    const result = await request(`/api/spaces/${spaceId}/reset`, { clearSchedules: false });
    assert.equal(result.ok, true);
    assert.deepEqual(result.removed, { jobs: 0, monitors: 0 });
    assert.equal((await service.monitors.get(`monitor-${spaceId}`))!.pendingNotification, undefined);
    assert.ok(await service.jobs.get(`job-${spaceId}`));
  }
  const cleared = await request("/api/spaces/custom-space/reset", { clearSchedules: true });
  assert.deepEqual(cleared.removed, { jobs: 1, monitors: 1 });
  assert.equal(await service.jobs.get("job-custom-space"), undefined);
  assert.equal(await service.monitors.get("monitor-custom-space"), undefined);
  assert.ok(await service.jobs.get("job-local-main"));
  assert.ok(await service.monitors.get("monitor-local-main"));
});
