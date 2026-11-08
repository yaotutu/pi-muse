import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { endpoints } from "../../src/http/contracts/endpoints.js";
import { traceDetailResponse, tracesResponse } from "../../src/http/contracts/traces.js";
import type { ModelTraceRecord } from "../../src/adapters/model-trace/store.js";

const record = (startedAt: string, sessionId = "alpha", kind: ModelTraceRecord["meta"]["kind"] = "chat"): ModelTraceRecord => ({
  meta: { startedAt, endedAt: "2026-10-02T13:00:00.000Z", durationMs: 200, sessionId, kind,
    extra: { runId: "diagnostic-run" }, upstreamOrigin: "https://example.invalid", httpStatus: 200 },
  request: { system: "system\n全文", messages: [{ role: "user", content: "question" }, { role: "tool", name: "read", content: "result" }],
    tools: [{ type: "function", function: { name: "read", description: "读取", parameters: { type: "object" } } }], sampling: { temperature: 0.2, model: "test" } },
  response: { outputText: "response全文", toolCalls: [{ name: "read", arguments: '{"path":"a"}' }], finishReason: "stop", usage: { total_tokens: 12 }, truncated: true, disconnected: true, failure: "diagnostic failure", errorBody: "error body", streamDone: true },
});

/** 当前 Hono + bootstrap 的真实读取链路；只用隔离 trace 夹具，不调用任何模型。 */
test("traces: authenticated read-only contracts, pagination, filters, corruption and traversal", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-traces-contract-"));
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  t.after(async () => { await service?.close(); await rm(dataDir, { recursive: true, force: true }); });
  service = await createService(createConfig({
    traces: { enabled: false }, runtime: { dataDir, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
  }));
  const app = service.app;
  const headers = { Authorization: `Bearer ${service.auth.login()}` };
  for (const path of ["/api/traces", "/api/traces/invalid", "/api/traces/2026-10-01/invalid"]) {
    assert.equal((await app.request(path)).status, 401);
    assert.equal((await app.request(path, { headers: { Authorization: "Bearer invalid" } })).status, 401);
  }
  const getPage = async (query = "") => {
    const result = await app.request(`/api/traces${query}`, { headers });
    assert.equal(result.status, 200);
    return tracesResponse.parse(await result.json());
  };
  assert.deepEqual(await getPage(), { traces: [], badCount: 0, hasMore: false, nextCursor: null });
  await assert.rejects(readdir(service.layout.tracesDir), { code: "ENOENT" }, "GET must not create missing trace root");
  const root = service.layout.tracesDir;
  const oldDay = "2026-10-01", day = "2026-10-02";
  await mkdir(join(root, oldDay), { recursive: true });
  await mkdir(join(root, day));
  const entries = [
    { day, name: "120000-000-alpha-chat-000001.json", data: record("2026-10-02T12:00:00.000Z") },
    // 完成文件的时间不等于开始时间：确保按 startedAt 排序，并按该排序中的文件名锚点翻页。
    { day, name: "130000-000-beta-dream-000002.json", data: record("2026-10-02T11:00:00.000Z", "beta", "dream") },
    { day, name: "110000-000-alpha-chat-000003.json", data: record("2026-10-02T10:00:00.000Z") },
    { day: oldDay, name: "220000-000-alpha-chat-000004.json", data: record("2026-10-01T22:00:00.000Z") },
  ];
  for (const entry of entries) await writeFile(join(root, entry.day, entry.name), JSON.stringify(entry.data));
  const invalidName = "140000-000-alpha-chat-000005.json";
  await writeFile(join(root, day, invalidName), "{broken");
  await writeFile(join(root, day, "140000-000-alpha-chat-000006.json"), '{"meta":{}}');
  await writeFile(join(root, day, ".pending.tmp"), "not committed");
  // 真实外部文件不能经符号链接读入诊断接口。
  const outside = join(dataDir, "outside.json");
  await writeFile(outside, JSON.stringify(record("2026-10-02T12:30:00.000Z")));
  const linkedName = "140000-000-alpha-chat-000007.json";
  await symlink(outside, join(root, day, linkedName));
  const before = await Promise.all(entries.map((entry) => readFile(join(root, entry.day, entry.name), "utf8")));
  const page = await getPage("?limit=2");
  assert.equal(page.badCount, 3);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.traces.map((entry) => entry.fileName), entries.slice(0, 2).map((entry) => `${entry.day}.${entry.name}`));
  assert.equal(page.traces[0]!.systemChars, entries[0]!.data.request!.system.length);
  assert.equal(page.traces[0]!.messageCount, 2);
  assert.equal(page.traces[0]!.toolCount, 1);
  assert.equal(page.traces[0]!.outputChars, entries[0]!.data.response!.outputText.length);
  assert.equal(page.traces[0]!.truncated, true);
  assert.equal(page.traces[0]!.disconnected, true);
  assert.equal(page.traces[0]!.failure, true);
  assert.deepEqual(page.traces[0]!.meta, entries[0]!.data.meta);
  assert.equal("request" in page.traces[0]!, false);
  assert.equal("response" in page.traces[0]!, false);
  const next = await getPage(`?limit=2&cursor=${page.nextCursor}`);
  assert.deepEqual(next.traces.map((entry) => entry.fileName), entries.slice(2).map((entry) => `${entry.day}.${entry.name}`));
  assert.equal(next.hasMore, false); assert.equal(next.nextCursor, null);
  assert.equal((await getPage("?sessionId=alpha&kind=chat")).traces.length, 3);
  assert.equal((await getPage("?sessionId=alph")).traces.length, 0);
  assert.equal((await getPage("?kind=dream")).traces.length, 1);
  assert.equal((await getPage("?since=2026-10-02&until=2026-10-02T11%3A00%3A00Z")).traces.length, 2);
  assert.equal((await getPage(`?since=${Date.parse("2026-10-02T11:00:00Z")}&until=${Date.parse("2026-10-02T11:00:00Z")}`)).traces.length, 1);
  assert.equal((await getPage("?limit=100")).traces.length, 4);
  for (const query of ["limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=1e1", "limit=", "limit=1&limit=2", "unknown=x", "kind=unknown", "since=invalid", "since=2026-02-30", "since=2026-10-03&until=2026-10-01", "cursor=oops", `cursor=${page.nextCursor}&sessionId=beta`]) {
    assert.equal((await app.request(`/api/traces?${query}`, { headers })).status, 400, query);
  }
  // 无 request/response 的合法旁路记录也可查看，统计为 0/false。
  const sparseName = "150000-000-alpha-chat-000008.json";
  await writeFile(join(root, day, sparseName), JSON.stringify({ meta: entries[0]!.data.meta }));
  const sparse = (await getPage()).traces.find((entry) => entry.fileName.endsWith(sparseName))!;
  assert.deepEqual([sparse.systemChars, sparse.messageCount, sparse.toolCount, sparse.outputChars, sparse.truncated, sparse.disconnected, sparse.failure], [0, 0, 0, 0, false, false, false]);
  for (const path of [`/api/traces/${day}.${entries[0]!.name}`, `/api/traces/${day}/${entries[0]!.name}`]) {
    const response = await app.request(path, { headers }); assert.equal(response.status, 200);
    const detail = traceDetailResponse.parse(await response.json());
    assert.deepEqual(detail, { fileName: `${day}.${entries[0]!.name}`, ...entries[0]!.data });
  }
  for (const name of [invalidName, linkedName, "140000-000-alpha-chat-999999.json"]) {
    assert.equal((await app.request(`/api/traces/${day}.${name}`, { headers })).status, 404);
  }
  for (const path of ["/api/traces/not-a-trace", `/api/traces/${day}.%2Foutside.json`, `/api/traces/${day}/..%2Foutside.json`, `/api/traces/${day}/..%5Coutside.json`, "/api/traces/%2e%2e%2foutside.json", `/api/traces/not-a-day/${entries[0]!.name}`]) {
    assert.equal((await app.request(path, { headers })).status, 400, path);
  }
  assert.deepEqual(await Promise.all(entries.map((entry) => readFile(join(root, entry.day, entry.name), "utf8"))), before, "GET must never rewrite diagnostic records");
  await unlink(join(root, entries[1]!.day, entries[1]!.name));
  assert.equal((await app.request(`/api/traces?cursor=${page.nextCursor}`, { headers })).status, 400, "removed anchor must require restart");

  const specResult = await app.request("/openapi.json"); assert.equal(specResult.status, 200);
  const spec = await specResult.json() as { paths: Record<string, Record<string, { description: string; security: unknown[]; parameters?: Array<{ name: string }>; responses: Record<string, unknown> }>> };
  assert.equal((await app.request("/docs")).status, 200);
  const traceEndpoints = endpoints.filter((entry) => entry.path.startsWith("/api/traces"));
  assert.equal(traceEndpoints.length, 3);
  for (const entry of traceEndpoints) {
    assert.equal(entry.method, "get"); assert.equal(entry.auth, true); assert.equal(entry.sse, undefined);
    const path = entry.path.replace(/:([A-Za-z]+)/g, "{$1}");
    const operation = spec.paths[path]!.get!;
    assert.ok(operation.security.length);
    assert.match(operation.description, /诊断/);
    assert.match(operation.description, /400/);
    assert.ok(operation.responses["200"]);
    assert.deepEqual(Object.keys(spec.paths[path]!), ["get"]);
  }
  assert.deepEqual(spec.paths["/api/traces"]!.get!.parameters!.map((entry) => entry.name).sort(), ["sessionId", "cursor", "kind", "limit", "since", "until"].sort());
  assert.match(spec.paths["/api/traces"]!.get!.description, /badCount/);
  assert.match(spec.paths["/api/traces/{fileName}"]!.get!.description, /符号链接/);
});
