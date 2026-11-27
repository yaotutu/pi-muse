import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDataLayout, ensureLayout } from "../../src/adapters/storage/data-layout.js";
import { createMcpAssistantOverridesRepository, createMcpRepository } from "../../src/adapters/storage/mcp-repository.js";
import { createPiMcpConnector } from "../../src/adapters/mcp/pi-mcp-connector.js";
import { createMcpService } from "../../src/features/mcp/service.js";
import { McpError } from "../../src/features/mcp/types.js";

const writeStdioFixture = async (dir: string) => {
  const script = join(dir, "stdio-mcp-server.mjs");
  await writeFile(
    script,
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
        serverInfo: { name: "fixture-stdio", version: "1.0.0" },
        instructions: "Echo text over stdio",
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
          name: "echo-text",
          description: "Echo input text",
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
    const input = msg.params?.arguments?.message ?? "";
    const token = process.env.SECRET_ENV_KEY ?? "";
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{ type: "text", text: "STDIO_ECHO:" + input + ":" + token }],
      },
    }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
});
`,
    "utf8",
  );
  return script;
};

test("mcp service connects real stdio server, redacts secrets, patches toggles, and persists mcp.json", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-mcp-stdio-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = createDataLayout(root);
  await ensureLayout(layout);
  const script = await writeStdioFixture(root);

  const service = createMcpService({
    repository: createMcpRepository(layout),
    assistantOverridesRepository: createMcpAssistantOverridesRepository(layout),
    connector: createPiMcpConnector({ workspaceDir: layout.workspaceDir, version: "0.1.0" }),
  });
  t.after(() => service.close());

  const beforeGet = await service.list();
  assert.deepEqual(beforeGet, { servers: [], diagnostics: [] });

  const view = await service.upsert("echo_srv", {
    command: process.execPath,
    args: [script],
    env: { SECRET_ENV_KEY: "top-secret-env-value" },
    description: "Stdio echo service",
  });
  assert.equal(view.name, "echo_srv");
  assert.equal(view.transport, "stdio");
  assert.equal(view.status, "connected");
  assert.equal(view.toolCount, 1);
  assert.equal(view.tools[0]?.exposedName, "mcp__echo_srv__echo_text");
  assert.deepEqual(view.envKeys, ["SECRET_ENV_KEY"]);
  assert.doesNotMatch(JSON.stringify(view), /top-secret-env-value/);

  const rawSaved = JSON.parse(await readFile(layout.mcpConfigFile, "utf8"));
  assert.equal(rawSaved.mcpServers.echo_srv.env.SECRET_ENV_KEY, "top-secret-env-value");

  const active = await service.getActiveTools();
  assert.equal(active.length, 1);
  const result = await active[0]!.execute({ message: "hello" });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /\[External content/);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /STDIO_ECHO:hello:top-secret-env-value/);

  // 禁用后保持配置与密钥，但工具立即下线
  const disabled = await service.patch("echo_srv", { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, "disabled");
  assert.deepEqual(disabled.envKeys, ["SECRET_ENV_KEY"]);
  assert.equal((await service.getActiveTools()).length, 0);

  // 重新启用时仍保留此前持久化密钥
  const enabled = await service.patch("echo_srv", { enabled: true });
  assert.equal(enabled.status, "connected");
  assert.equal((await service.getActiveTools()).length, 1);

  // 主聊天默认全部开启，独立关闭后全局仍在线且可供显式授权的 Agent 使用
  const initialSel = await service.describeAssistantSelection();
  assert.equal(initialSel.servers[0]?.defaultEnabled, true);
  assert.equal(initialSel.servers[0]?.enabled, true);
  assert.equal(initialSel.servers[0]?.effectiveEnabled, true);

  const muted = await service.updateAssistantOverrides({ echo_srv: false });
  assert.equal(muted.servers[0]?.globalEnabled, true);
  assert.equal(muted.servers[0]?.enabled, false);
  assert.equal(muted.servers[0]?.effectiveEnabled, false);
  assert.equal((await service.getActiveTools({ scope: "assistant" })).length, 0);
  assert.equal(service.getPromptSummaries({ scope: "assistant" }).length, 0);
  assert.equal((await service.getActiveTools({ allowedServers: new Set(["echo_srv"]) })).length, 1);
  assert.equal((await service.getActiveTools({ allowedServers: new Set() })).length, 0);

  await assert.rejects(
    () => service.updateAssistantOverrides({ missing_server: false }),
    (err: unknown) => err instanceof McpError && err.status === 400,
  );
  await service.remove("echo_srv");
  const afterRemove = await service.describeAssistantSelection();
  assert.deepEqual(afterRemove, { servers: [], overrides: {} });
});

test("mcp service connects real Streamable HTTP server with custom headers redacted from views", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-mcp-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = createDataLayout(root);
  await ensureLayout(layout);

  let seenAuth = "";
  const server = createServer(async (req, res) => {
    seenAuth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    if (seenAuth !== "Bearer http-secret-token") {
      res.writeHead(401).end("Unauthorized");
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown = {};
    if (msg.method === "initialize") {
      result = {
        protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture-http", version: "1.0.0" },
      };
    } else if (msg.method === "tools/list") {
      result = {
        tools: [{
          name: "ping",
          description: "Remote ping",
          inputSchema: { type: "object", properties: { label: { type: "string" } } },
        }],
      };
    } else if (msg.method === "tools/call") {
      result = {
        content: [{ type: "text", text: `HTTP_PONG:${msg.params?.arguments?.label ?? ""}` }],
      };
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "sess-1",
    });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;

  const service = createMcpService({
    repository: createMcpRepository(layout),
    assistantOverridesRepository: createMcpAssistantOverridesRepository(layout),
    connector: createPiMcpConnector({ workspaceDir: layout.workspaceDir, version: "0.1.0" }),
  });
  t.after(() => service.close());

  const view = await service.upsert("remote-docs", {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: "Bearer http-secret-token" },
  });
  assert.equal(view.transport, "http");
  assert.equal(view.status, "connected");
  assert.deepEqual(view.headerNames, ["Authorization"]);
  assert.doesNotMatch(JSON.stringify(view), /http-secret-token/);

  const active = await service.getActiveTools();
  assert.equal(active.length, 1);
  assert.equal(active[0]?.exposedName, "mcp__remote_docs__ping");
  const out = await active[0]!.execute({ label: "ok" });
  assert.match(out.content[0]?.type === "text" ? out.content[0].text : "", /HTTP_PONG:ok/);
  assert.equal(seenAuth, "Bearer http-secret-token");
});

test("mcp service enforces name/namespace validation and rejects symlinked mcp.json", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-mcp-sec-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = createDataLayout(root);
  await ensureLayout(layout);

  const service = createMcpService({
    repository: createMcpRepository(layout),
    connector: {
      connect: async () => ({
        summary: "",
        tools: [],
        callTool: async () => ({ content: [] }),
        close: async () => {},
      }),
    },
  });
  t.after(() => service.close());

  await assert.rejects(
    () => service.upsert("bad/name", { command: "node" }),
    (err: unknown) => err instanceof McpError && err.status === 400,
  );
  await assert.rejects(
    () => service.upsert("both", { command: "node", url: "https://example.com/mcp" }),
    (err: unknown) => err instanceof McpError && err.status === 400,
  );
  await assert.rejects(
    () => service.upsert("cred_url", { url: "https://user:pass@example.com/mcp" }),
    (err: unknown) => err instanceof McpError && err.status === 400,
  );

  await service.upsert("my-server", { url: "https://example.com/mcp", enabled: false });
  await assert.rejects(
    () => service.upsert("my_server", { url: "https://example.com/mcp", enabled: false }),
    (err: unknown) => err instanceof McpError && err.status === 409,
  );

  // 符号链接替换 mcp.json 时拒绝读取或写入
  const outside = join(root, "outside.json");
  await writeFile(outside, JSON.stringify({ mcpServers: {} }), "utf8");
  await rm(layout.mcpConfigFile, { force: true });
  await symlink(outside, layout.mcpConfigFile);
  const linkedRepo = createMcpRepository(layout);
  await assert.rejects(
    () => linkedRepo.load(),
    (err: unknown) => err instanceof McpError && err.code === "CONFIG_CORRUPT",
  );
});
