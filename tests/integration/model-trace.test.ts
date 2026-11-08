import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig, type ConfigFileInput } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";

/**
 * 模型调用追踪的集成回归：经真实 createService 组装（含回环记录代理），
 * 用 fake provider 跑主聊天与信息批后核对磁盘上的 trace 快照；另覆盖
 * enabled=false 零文件与写失败不影响模型调用两条硬边界。
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error("Condition timed out");
}

const traceFiles = async (dir: string): Promise<string[]> => {
  try {
    const days = await readdir(dir);
    const files: string[] = [];
    for (const day of days.sort()) {
      for (const name of (await readdir(join(dir, day))).sort()) files.push(join(dir, day, name));
    }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(overrides: Partial<ConfigFileInput> = {}, prepare?: (dataDir: string) => void | Promise<void>) {
  let model: Awaited<ReturnType<typeof createFakeModel>> | undefined;
  let dataDir: string | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  const close = async () => {
    const currentModel = model;
    const currentDataDir = dataDir;
    const currentService = service;
    model = undefined;
    dataDir = undefined;
    service = undefined;
    try {
      await currentService?.close();
    } finally {
      try {
        await currentModel?.close();
      } finally {
        if (currentDataDir) await rm(currentDataDir, { recursive: true, force: true });
      }
    }
  };
  try {
    model = await createFakeModel();
    dataDir = await mkdtemp(join(tmpdir(), "model-trace-it-"));
    await prepare?.(dataDir);
    const config = createConfig({
      schemaVersion: 1,
      server: {},
      model: {
        baseUrl: model.baseUrl,
        id: "test-model",
        apiKey: "test-secret-model-key",
        contextWindow: 128000,
        ...overrides.model,
      },
      runtime: {
        dataDir,
        runTimeoutMs: 8000,
        schedulerIntervalMs: 2000,
        monitorScanIntervalMs: 500,
        ...overrides.runtime,
      },
      ...("traces" in overrides ? { traces: overrides.traces } : {}),
    });
    service = await createService(config);
    const token = service.auth.login();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const call = async (path: string, init?: RequestInit) => {
      const response = await service!.app.request(path, { headers, ...init });
      return { status: response.status, body: await response.json().catch(() => undefined) as unknown };
    };
    const runChat = async (content: string) => {
      const response = await service!.app.request("/api/conversation/run", {
        headers,
        method: "POST",
        body: JSON.stringify({
          sessionId: "main",
          runId: randomUUID(),
          expectedRevision: "empty",
          message: { id: randomUUID(), content },
        }),
      });
      assert.equal(response.status, 200);
      return (await response.text())
        .split("\n\n")
        .filter((part) => part.startsWith("data: "))
        .map((part) => JSON.parse(part.slice(6)) as { type: string });
    };
    return { model: model!, dataDir, call, runChat, close };
  } catch (error) {
    await close();
    throw error;
  }
}

type TraceFile = {
  meta: { sessionId: string; kind: string; extra?: Record<string, string>; upstreamOrigin: string; httpStatus: number; durationMs: number };
  request: { system: string; messages: Array<{ role: string; content: unknown }>; tools: Array<{ function?: { name?: string } }>; sampling: Record<string, unknown> };
  response: { outputText: string; finishReason?: string; streamDone?: boolean; truncated: boolean; errorBody?: string };
};

const readTraces = async (dataDir: string): Promise<Array<{ name: string; trace: TraceFile }>> => {
  const files = await traceFiles(join(dataDir, "traces"));
  return Promise.all(files.map(async (file) => ({
    name: file.split("/").at(-1)!,
    trace: JSON.parse(await readFile(file, "utf8")) as TraceFile,
  })));
};

test("chat round records a full trace snapshot with sessionId, kind, system and messages", async () => {
  const h = await fixture();
  try {
    const events = await h.runChat("trace-marker-hello");
    assert.ok(events.some((event) => event.type === "RUN_FINISHED"));
    await until(async () => (await traceFiles(join(h.dataDir, "traces"))).length > 0);
    const traces = await readTraces(h.dataDir);
    assert.equal(traces.length, 1);
    const { name, trace } = traces[0]!;
    assert.match(name, /^\d{6}-\d{3}-main-chat-\d{6}\.json$/);
    assert.equal(trace.meta.sessionId, "main");
    assert.equal(trace.meta.kind, "chat");
    assert.ok(trace.meta.extra?.runId);
    assert.equal(trace.meta.upstreamOrigin, new URL(h.model.baseUrl).origin);
    assert.equal(trace.meta.httpStatus, 200);
    assert.ok(trace.meta.durationMs >= 0);
    assert.ok(trace.request.system.length > 0, "system prompt must be captured in full");
    const roles = trace.request.messages.map((message) => message.role);
    assert.ok(roles.includes("system"));
    assert.equal(roles.at(-1), "user");
    assert.ok(JSON.stringify(trace.request.messages.at(-1)?.content).includes("trace-marker-hello"));
    assert.ok(trace.request.tools.some((tool) => tool.function?.name === "read"), "declared tools must be captured");
    assert.equal(trace.request.sampling.model, "test-model");
    assert.ok(trace.response.outputText.includes("reply: trace-marker-hello"));
    assert.equal(trace.response.finishReason, "stop");
    assert.equal(trace.response.streamDone, true);
    assert.equal(trace.response.truncated, false);
  } finally {
    await h.close();
  }
});

test("information batch records its own kind, sessionId and informationRunId", async () => {
  const h = await fixture();
  try {
    const sessionId = "main";
    assert.equal((await h.call(`/api/sessions/${sessionId}/instructions`, {
      method: "PUT",
      body: JSON.stringify({ instructions: "Always be concise." }),
    })).status, 200);
    assert.equal((await h.call(`/api/information/settings`, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, batchWindowSeconds: 3600 }),
    })).status, 200);
    assert.equal((await h.call(`/api/information/items`, {
      method: "POST",
      body: JSON.stringify({ items: [{ source: "rss", externalId: "trace-1", content: "NOTIFY trace batch" }] }),
    })).status, 200);
    const run = await h.call(`/api/information/runs`, { method: "POST", body: "{}" });
    assert.equal(run.status, 200);
    const runId = (run.body as { run?: { id?: string } }).run?.id;
    assert.ok(runId);
    await until(async () =>
      (await readTraces(h.dataDir)).some(({ trace }) => trace.meta.kind === "information:notifications"));
    const trace = (await readTraces(h.dataDir)).find(({ trace }) => trace.meta.kind === "information:notifications")!;
    assert.equal(trace.trace.meta.sessionId, sessionId);
    assert.equal(trace.trace.meta.extra?.informationRunId, runId);
    assert.ok(trace.trace.request.system.includes("structured information decision worker"));
    assert.ok(JSON.stringify(trace.trace.request.messages).includes("NOTIFY trace batch"));
    assert.ok(trace.trace.request.tools.some((tool) => tool.function?.name === "submit_information_result"));
    assert.equal(trace.trace.meta.httpStatus, 200);
  } finally {
    await h.close();
  }
});

test("upstream failure records redacted error body for troubleshooting", async () => {
  // 专用上游把收到的 Bearer key 原样回显进 401 正文，验证端到端脱敏不依赖 fixture 细节。
  let seenBearer = "";
  const echo = createServer((request, response) => {
    seenBearer = String(request.headers.authorization ?? "");
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `Invalid API key ${seenBearer.replace(/^Bearer /, "")}`, type: "invalid_api_key" } }));
  });
  echo.listen(0, "127.0.0.1");
  await once(echo, "listening");
  let h: Fixture | undefined;
  try {
    h = await fixture({ model: { baseUrl: `http://127.0.0.1:${(echo.address() as AddressInfo).port}` } });
    const events = await h.runChat("hello");
    assert.ok(events.some((event) => event.type === "RUN_ERROR"), "401 upstream should fail the run");
    await until(async () => (await traceFiles(join(h!.dataDir, "traces"))).length > 0);
    assert.ok(seenBearer.startsWith("Bearer "));
    const file = (await traceFiles(join(h.dataDir, "traces"))).at(-1)!;
    const text = await readFile(file, "utf8");
    const rawKey = seenBearer.replace(/^Bearer /, "");
    assert.ok(!text.includes(rawKey), "raw model key must never reach the trace file");
    assert.ok(text.includes("[REDACTED]"));
    const trace = JSON.parse(text) as TraceFile;
    assert.equal(trace.meta.httpStatus, 401);
    assert.ok(trace.response.errorBody?.includes("[REDACTED]"));
  } finally {
    await h?.close();
    echo.closeAllConnections();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  }
});

test("traces disabled keeps current behavior and writes zero files", async () => {
  const h = await fixture({ traces: { enabled: false } });
  try {
    const events = await h.runChat("hello-no-trace");
    assert.ok(events.some((event) => event.type === "RUN_FINISHED"));
    // provider 注册回到真实 baseUrl：fake provider 直接收到请求，且没有产生任何代理/文件。
    assert.equal(h.model.requests.length, 1);
    const entries = await readdir(h.dataDir);
    assert.ok(!entries.includes("traces"), "no traces directory should exist when disabled");
  } finally {
    await h.close();
  }
});

test("trace write failure never affects the model call", async () => {
  let errors = 0;
  const original = console.error;
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes("[pi-muse/model-trace]")) errors += 1;
    original(...args.map(() => "[suppressed]"));
  };
  const h = await fixture({}, async (dataDir) => {
    // 占据 traces 根，令每次落盘必然失败；模型调用必须照常完成。
    await writeFile(join(dataDir, "traces"), "not a directory");
  });
  try {
    const events = await h.runChat("hello-broken-trace");
    assert.ok(events.some((event) => event.type === "RUN_FINISHED"), "chat must complete normally");
    assert.equal(h.model.requests.length, 1, "model call must reach the provider exactly once");
    await until(() => errors > 0);
    await sleep(50);
    assert.ok(errors >= 1, "sanitized failure summary must be logged");
    assert.ok((await stat(join(h.dataDir, "traces"))).isFile(), "traces root stays a plain file (no writes succeeded)");
  } finally {
    console.error = original;
    await h.close();
  }
});
