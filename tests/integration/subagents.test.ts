import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../support/test-service.js";
import { createFakeModel } from "../support/fake-model.js";
import { createConfig } from "../../src/config/load-config.js";
import {
  subagentDetailResponseSchema,
  subagentMcpSelectionResponseSchema,
  subagentsListResponseSchema,
} from "../../src/http/contracts/subagents.js";

test("GET /api/subagents and GET /api/subagents/:id expose all 5 specialized subagents and full capabilities", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-subagents-api-"));
  const accessKey = "subagents-test-key";
  const service = await createService(createConfig({
    runtime: { dataDir },
    server: { host: "127.0.0.1", accessKey },
  }));
  try {
    const login = await service.app.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessKey }),
    });
    assert.equal(login.status, 200);
    const { token } = (await login.json()) as { token: string };
    const headers = { authorization: `Bearer ${token}` };

    const listRes = await service.app.request("/api/subagents", { headers });
    assert.equal(listRes.status, 200);
    const listBody = subagentsListResponseSchema.parse(await listRes.json());
    assert.deepEqual(
      listBody.subagents.map((item) => item.id),
      ["sms", "news", "browser", "habits", "dream"],
    );

    // 验证所有 5 个 Subagent 详情都严格满足契约并暴露提示词、工具、技能与 MCP 槽位
    for (const id of ["sms", "news", "browser", "habits", "dream"]) {
      const detailRes = await service.app.request(`/api/subagents/${id}`, { headers });
      assert.equal(detailRes.status, 200);
      const detail = subagentDetailResponseSchema.parse(await detailRes.json());
      assert.equal(detail.id, id);
      assert.equal(detail.executionPolicy.stateless, true);
      assert.ok(detail.prompts.length >= 1, `${id} should expose builtin prompts`);
      assert.ok(detail.capabilities.tools.length >= 1, `${id} should expose tools`);
      assert.ok(Array.isArray(detail.capabilities.skills));
      assert.deepEqual(detail.capabilities.mcp, []);
      assert.equal(detail.editability.mcp, id === "habits" || id === "dream" ? "readonly" : "editable");
      if (id === "sms" || id === "news" || id === "browser") {
        assert.ok(typeof detail.routingHint === "string" && detail.routingHint.length > 0, `${id} should own routingHint`);
      } else {
        assert.equal(detail.routingHint, null);
      }
      if (id === "sms" || id === "news") {
        assert.equal(detail.hasUserInstructions, true);
        assert.equal(detail.editability.userInstructions, "editable");
        assert.ok(detail.userInstructions?.path.endsWith("AGENTS.md"));
      } else {
        assert.equal(detail.hasUserInstructions, false);
        assert.equal(detail.userInstructions, null);
      }
    }

    const badId = await service.app.request("/api/subagents/INVALID!", { headers });
    assert.equal(badId.status, 400);

    const missing = await service.app.request("/api/subagents/scout", { headers });
    assert.equal(missing.status, 404);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Subagent MCP opt-in binding defaults to off, isolates tools by subagent, persists, and prunes on delete", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-subagent-mcp-"));
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
        serverInfo: { name: "sub-echo", version: "1.0.0" },
        instructions: "Echo tool for subagent MCP testing",
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

  const cfg = createConfig({
    schemaVersion: 1,
    runtime: { dataDir, runTimeoutMs: 5000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    server: { host: "127.0.0.1", accessKey: "subagent-mcp-key" },
    model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "k" },
  });
  service = await createService(cfg);
  const token = service.auth.login("subagent-mcp-key")!;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  // 注册全局 MCP 服务
  const putMcp = await service.app.request("/api/mcp/servers/demo_echo", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      command: process.execPath,
      args: [echoScript],
      description: "Subagent echo MCP",
    }),
  });
  assert.equal(putMcp.status, 200);

  // 所有 Subagent 默认不启用该 MCP 服务
  const smsInitialRes = await service.app.request("/api/subagents/sms/mcp", { headers });
  assert.equal(smsInitialRes.status, 200);
  const smsInitial = subagentMcpSelectionResponseSchema.parse(await smsInitialRes.json());
  assert.equal(smsInitial.editable, true);
  assert.deepEqual(smsInitial.enabledServers, []);
  assert.equal(smsInitial.servers.length, 1);
  assert.equal(smsInitial.servers[0]?.defaultEnabled, false);
  assert.equal(smsInitial.servers[0]?.enabled, false);

  // 后台固定结构化 Subagent 返回 readonly，禁止绑定 MCP
  const habitsSelection = subagentMcpSelectionResponseSchema.parse(
    await (await service.app.request("/api/subagents/habits/mcp", { headers })).json(),
  );
  assert.equal(habitsSelection.editable, false);
  const habitsUpdate = await service.app.request("/api/subagents/habits/mcp", {
    method: "PUT",
    headers,
    body: JSON.stringify({ servers: ["demo_echo"] }),
  });
  assert.equal(habitsUpdate.status, 400);

  // 未知全局 MCP 名称拒绝保存
  const unknownUpdate = await service.app.request("/api/subagents/sms/mcp", {
    method: "PUT",
    headers,
    body: JSON.stringify({ servers: ["nonexistent"] }),
  });
  assert.equal(unknownUpdate.status, 400);

  // 仅授权 sms 使用 demo_echo
  const smsEnableRes = await service.app.request("/api/subagents/sms/mcp", {
    method: "PUT",
    headers,
    body: JSON.stringify({ servers: ["demo_echo"] }),
  });
  assert.equal(smsEnableRes.status, 200);
  const smsEnabled = subagentMcpSelectionResponseSchema.parse(await smsEnableRes.json());
  assert.deepEqual(smsEnabled.enabledServers, ["demo_echo"]);
  assert.equal(smsEnabled.servers[0]?.effectiveEnabled, true);

  // GET /api/subagents/:id 同步体现已绑定的 MCP，news 保持空
  const smsDetail = subagentDetailResponseSchema.parse(
    await (await service.app.request("/api/subagents/sms", { headers })).json(),
  );
  assert.deepEqual(smsDetail.capabilities.mcp, [
    { name: "demo_echo", description: "Subagent echo MCP", transport: "stdio" },
  ]);
  const newsDetail = subagentDetailResponseSchema.parse(
    await (await service.app.request("/api/subagents/news", { headers })).json(),
  );
  assert.deepEqual(newsDetail.capabilities.mcp, []);

  // 运行时隔离验证：sms 能调用 mcp__demo_echo__echo，news 看不到该工具
  const smsRun = await service.subagents.runChatTask("sms", "调用MCP回显", {
    sessionId: "main",
    subagentId: "subagent-sms-1",
  });
  assert.equal(smsRun.isError, false);
  assert.match(smsRun.output, /MCP_RESULT:mcp-echo-test/);

  const newsRun = await service.subagents.runChatTask("news", "调用MCP回显", {
    sessionId: "main",
    subagentId: "subagent-news-1",
  });
  assert.equal(newsRun.isError, false);
  assert.doesNotMatch(newsRun.output, /MCP_RESULT:mcp-echo-test/);

  // 重启服务后选用状态持久化生效
  await service.close();
  service = await createService(cfg);
  const token2 = service.auth.login("subagent-mcp-key")!;
  const headers2 = { authorization: `Bearer ${token2}` };
  const smsPersisted = subagentMcpSelectionResponseSchema.parse(
    await (await service.app.request("/api/subagents/sms/mcp", { headers: headers2 })).json(),
  );
  assert.deepEqual(smsPersisted.enabledServers, ["demo_echo"]);

  // 删除全局 MCP 服务时自动从 Subagent 选用列表清理
  const delMcp = await service.app.request("/api/mcp/servers/demo_echo", {
    method: "DELETE",
    headers: headers2,
  });
  assert.equal(delMcp.status, 200);
  const smsAfterDelete = subagentMcpSelectionResponseSchema.parse(
    await (await service.app.request("/api/subagents/sms/mcp", { headers: headers2 })).json(),
  );
  assert.deepEqual(smsAfterDelete.enabledServers, []);
  assert.deepEqual(smsAfterDelete.servers, []);
});
