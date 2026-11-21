import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { parseLiveOptions, type LiveOptions } from "./options.js";

const inspect = (file: string, table: "live_database_probe" | "live_database_notes") => {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    return database.prepare(`SELECT id, value FROM ${table} ORDER BY id`).all();
  } finally {
    database.close();
  }
};

const execute = async (options: LiveOptions) => {
  const { createService } = await import("../support/test-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createLiveModel, redactApiKey } = await import("../support/live-model.js");
  const { createTestClient } = await import("../support/http-client.js");
  const raw = JSON.parse(await readFile(options.configPath, "utf8")) as { model?: unknown };
  const model = createConfig({ server: { host: "127.0.0.1" }, model: raw.model });
  if (!model.configured || !model.baseUrl || !model.modelId) throw new Error("Model configuration is required");

  let root: string | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let proxy: Awaited<ReturnType<typeof createLiveModel>> | undefined;
  let http: ReturnType<typeof serve> | undefined;
  let baseUrl = "";
  let failure: string | undefined;
  let serviceVersion: unknown;
  const evidence: Array<{ name: string; detail: Record<string, unknown> }> = [];
  const cleanupFailures: string[] = [];
  const accessKey = randomUUID();
  const marker = `SQLITE_LIVE_${randomUUID().replaceAll("-", "")}`;
  const record = (name: string, detail: Record<string, unknown>) => {
    evidence.push({ name, detail });
    process.stdout.write(`[PASS] ${name}\n`);
  };
  const stopHttp = async () => {
    if (!http) return;
    const current = http;
    http = undefined;
    if ("closeAllConnections" in current) current.closeAllConnections();
    await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
  };
  const configFor = (dataDir: string) => createConfig({
    server: { host: "127.0.0.1", accessKey },
    model: {
      baseUrl: proxy!.baseUrl, id: model.modelId, apiKey: "proxy-placeholder",
      contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    },
    runtime: { dataDir, runTimeoutMs: 180_000, schedulerIntervalMs: 3_600_000, monitorScanIntervalMs: 3_600_000 },
    tools: { presentation: { default: "summary" }, web: { enabled: false }, browser: { enabled: false } },
  });
  const start = async (dataDir: string) => {
    service = await createService(configFor(dataDir));
    http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!http.listening) await once(http, "listening");
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(baseUrl + "/api/session", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessKey }),
    });
    assert.equal(response.status, 200);
    const { token } = await response.json() as { token: string };
    return createTestClient(() => baseUrl, token, 240_000);
  };

  try {
    root = await mkdtemp(join(tmpdir(), "pi-muse-database-live-"));
    const dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });
    proxy = await createLiveModel({ baseUrl: model.baseUrl, apiKey: model.apiKey });
    let client = await start(dataDir);
    serviceVersion = (await client.json("/api/health") as { serviceVersion: unknown }).serviceVersion;
    const sessionId = (await client.createSession("SQLite live verification")).id;
    const run = async (name: string, instruction: string) => {
      const baseline = proxy!.traces.length;
      const request = await client.startRun(
        `这是隔离实例的数据库验收，只操作以下合成测试数据。使用 database 工具完成要求，不调用其他工具，不重试失败操作。${instruction}`,
        sessionId,
      );
      const events = await request.done;
      assert.equal(events.at(-1)?.type, "RUN_FINISHED", `${name}: model run failed`);
      const traces = proxy!.traces.slice(baseline);
      const calls = traces.flatMap((trace) => trace.calls);
      assert.ok(calls.some((call) => call.name === "database"), `${name}: real model must call database`);
      assert.ok(calls.every((call) => call.name === "database"), `${name}: unexpected tool`);
      assert.ok(traces.every((trace) => trace.upstreamStatus === 200), `${name}: upstream request failed`);
      return { calls: calls.length, results: traces.flatMap((trace) => trace.toolResults).join("\n") };
    };

    const main = await run("main-write-query",
      `在 main 数据库创建 live_database_probe(id TEXT PRIMARY KEY, value TEXT NOT NULL)，插入 id='row-one'、value='${marker}'，最后查询这条记录。可以按工具参数使用批处理，也可多次调用。`);
    const mainRows = inspect(join(dataDir, "state", "main.sqlite"), "live_database_probe");
    assert.equal(mainRows.length, 1);
    assert.equal(mainRows[0]?.value, marker);
    assert.ok(main.results.includes(marker), "model must receive the stored SQL result");
    record("real-agent-main-write-query", { toolCalls: main.calls, rows: mainRows.length });

    const news = await run("news-schema-extension",
      `在 news 数据库创建 live_database_notes(id TEXT PRIMARY KEY, value TEXT NOT NULL)，插入 id='note-one'、value='${marker}_NEWS'，查询该记录。不要修改 news_ 开头的内置表。`);
    assert.equal(inspect(join(dataDir, "state", "news.sqlite"), "live_database_notes")[0]?.value, marker + "_NEWS");
    assert.ok(news.results.includes(marker + "_NEWS"));
    const sources = await client.json("/api/news/sources") as { sources: unknown[] };
    assert.deepEqual(sources.sources, []);
    record("real-agent-news-custom-table", { toolCalls: news.calls, newsApiReadable: true });

    const oldService = service!;
    service = undefined;
    await stopHttp();
    await oldService.close();
    client = await start(dataDir);
    assert.equal(inspect(join(dataDir, "state", "main.sqlite"), "live_database_probe")[0]?.value, marker);
    assert.equal(inspect(join(dataDir, "state", "news.sqlite"), "live_database_notes")[0]?.value, marker + "_NEWS");
    record("database-restart-persistence", { databases: ["main", "news"] });

    const query = await run("read-after-restart",
      `只查询 main 数据库 live_database_probe 中 id='row-one' 的 value。不要新增或修改数据。`);
    assert.ok(query.results.includes(marker), "reopened real model must read persisted data");
    record("real-agent-read-after-restart", { toolCalls: query.calls });

    const drop = await run("drop-own-tables",
      "删除 main 数据库的 live_database_probe 表，再删除 news 数据库的 live_database_notes 表。无需请求审批。这两张表都只属于本次测试。不要删除其他表。");
    for (const [file, table] of [["main.sqlite", "live_database_probe"], ["news.sqlite", "live_database_notes"]] as const) {
      const database = new DatabaseSync(join(dataDir, "state", file), { readOnly: true });
      try {
        assert.equal(database.prepare("SELECT COUNT(*) AS total FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.total, 0);
      } finally { database.close(); }
    }
    assert.deepEqual((await client.json("/api/news/sources") as { sources: unknown[] }).sources, []);
    record("real-agent-drop-without-approval", { toolCalls: drop.calls });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (http) try { await stopHttp(); } catch { cleanupFailures.push("HTTP close failed"); }
    if (service) try { await service.close(); } catch { cleanupFailures.push("service close failed"); }
    if (proxy) try { await proxy.close(); } catch { cleanupFailures.push("proxy close failed"); }
    if (root && options.keepArtifacts) {
      await writeFile(join(root, "summary.json"), redactApiKey(JSON.stringify({
        passed: failure === undefined && cleanupFailures.length === 0,
        failure: failure ?? null, serviceVersion, scenarios: evidence,
        realModelRequests: proxy?.traces.length ?? 0, cleanupFailures,
      }, null, 2), model.apiKey) + "\n", { mode: 0o600 });
      await writeFile(join(root, "tool-traces.json"), redactApiKey(JSON.stringify(proxy?.traces ?? [], null, 2), model.apiKey) + "\n", { mode: 0o600 });
      process.stdout.write(`[ARTIFACTS] ${root}\n`);
    }
    if (root && !options.keepArtifacts) {
      try { await rm(root, { recursive: true, force: true }); } catch { cleanupFailures.push("temporary cleanup failed"); }
    }
    if (cleanupFailures.length) {
      process.exitCode = 1;
      process.stderr.write(`[CLEANUP-FAIL] ${cleanupFailures.join("; ")}\n`);
    }
  }
};

const outcome = parseLiveOptions(process.argv.slice(2));
if (outcome.kind === "help") {
  console.log(outcome.help.replace("pnpm test:live", "node --import tsx tests/live/database.ts"));
} else if (outcome.kind === "error") {
  console.error(outcome.message);
  process.exitCode = 1;
} else {
  try { await execute(outcome.options); }
  catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : "Database live verification failed"}`);
    process.exitCode = 1;
  }
}
