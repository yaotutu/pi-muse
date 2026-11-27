import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";
import { createTestClient } from "../support/http-client.js";

test("integration: MCP HTTP CRUD, secret redaction, direct model execution, and run step recording", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-mcp-int-"));
  const model = await createFakeModel();
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  t.after(async () => {
    await service?.close();
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const echoScript = join(dataDir, "echo-mcp.mjs");
  await writeFile(
    echoScript,
    `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "int-echo", version: "1.0.0" },
        instructions: "Echo tool for integration testing",
      },
    }) + "\\n");
    return;
  }
  if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [{
          name: "echo",
          description: "Echo message",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        }],
      },
    }) + "\\n");
    return;
  }
  if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{ type: "text", text: "MCP_RESULT:" + (msg.params?.arguments?.message ?? "") }],
      },
    }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
});
`,
    "utf8",
  );

  service = await createService(
    createConfig({
      schemaVersion: 1,
      server: { accessKey: "mcp-int-secret" },
      model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "k" },
      runtime: { dataDir, runTimeoutMs: 5000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    }),
  );
  const token = service.auth.login("mcp-int-secret")!;
  const baseUrl = "http://localhost";
  const fetchApp = async (path: string, init?: RequestInit) =>
    service!.app.request(baseUrl + path, init);

  // 未鉴权访问拦截
  assert.equal((await fetchApp("/api/mcp/servers")).status, 401);

  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const putRes = await fetchApp("/api/mcp/servers/demo_echo", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      command: process.execPath,
      args: [echoScript],
      env: { API_TOKEN: "secret-should-not-leak" },
      description: "Integration echo MCP",
    }),
  });
  assert.equal(putRes.status, 200);
  const putBody = (await putRes.json()) as { server: { status: string; toolCount: number; envKeys: string[] } };
  assert.equal(putBody.server.status, "connected");
  assert.equal(putBody.server.toolCount, 1);
  assert.deepEqual(putBody.server.envKeys, ["API_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(putBody), /secret-should-not-leak/);

  // 对话中模型直接调用 MCP 工具，不生成待审批，步骤时间线留下 MCP · demo_echo
  const client = createTestClient(
    () => "http://localhost",
    token,
    10_000,
    undefined,
  );
  // 复用 service.app.request 检查真实对话执行与 /api/runs
  const convRes = await fetchApp("/api/conversation?sessionId=main", { headers: { Authorization: `Bearer ${token}` } });
  const conv = (await convRes.json()) as { revision: string };
  const runId = "00000000-0000-4000-8000-000000000101";
  const runRes = await fetchApp("/api/conversation/run", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      sessionId: "main",
      runId,
      expectedRevision: conv.revision,
      message: { id: "00000000-0000-4000-8000-000000000102", content: "调用MCP回显" },
    }),
  });
  assert.equal(runRes.status, 200);
  const sseText = await runRes.text();
  assert.match(sseText, /RUN_FINISHED/);
  assert.match(sseText, /MCP_RESULT:mcp-echo-test/);

  const runsRes = await fetchApp("/api/runs?sessionId=main", { headers: { Authorization: `Bearer ${token}` } });
  const runsJson = (await runsRes.json()) as {
    runs: Array<{ runId: string; steps: Array<{ kind: string; title: string; detail: string | null; status: string }> }>;
  };
  const thisRun = runsJson.runs.find((r) => r.runId === runId);
  assert.ok(thisRun, "run should be recorded");
  assert.ok(
    thisRun.steps.some((step) => step.title === "MCP · demo_echo" && step.detail === "echo" && step.status === "succeeded"),
    `expected MCP step, got ${JSON.stringify(thisRun.steps)}`,
  );

  // 不应生成任何 pending approval
  const approvalsRes = await fetchApp("/api/approvals", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(((await approvalsRes.json()) as { approvals: unknown[] }).approvals.length, 0);

  // PATCH 禁用 + DELETE 移除 + 确认 client 变量未使用警告消除
  assert.ok(client);
  const patchRes = await fetchApp("/api/mcp/servers/demo_echo", {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(patchRes.status, 200);
  assert.equal(((await patchRes.json()) as { server: { status: string } }).server.status, "disabled");

  const delRes = await fetchApp("/api/mcp/servers/demo_echo", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(delRes.status, 200);
  const listRes = await fetchApp("/api/mcp/servers", { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await listRes.json(), { servers: [], diagnostics: [] });
});
