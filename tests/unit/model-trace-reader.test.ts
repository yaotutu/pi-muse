import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModelTraceReader } from "../../src/adapters/model-trace/reader.js";
import { createModelTraceStore, type ModelTraceRecord } from "../../src/adapters/model-trace/store.js";
import { modelTraceKindSchema, modelTraceRecordSchema } from "../../src/adapters/model-trace/schema.js";
import type { ModelTraceKind } from "../../src/adapters/model-trace/context.js";

type AssertNever<T extends never> = T;
type _TraceKindsCovered = AssertNever<Exclude<ModelTraceKind, (typeof modelTraceKindSchema.options)[number]>>;

test("trace reader: round-trips phase-one files without writing and rejects symlink boundaries", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-trace-reader-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "traces");
  const reader = createModelTraceReader(root);
  assert.deepEqual(await reader.list(), { records: [], badCount: 0 });
  assert.equal(await reader.read("../outside.json"), undefined);
  const store = createModelTraceStore({ dir: root, maxTotalBytes: 100_000 });
  const record: ModelTraceRecord = {
    meta: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 0, agentId: "agent-A", kind: "information:notifications", upstreamOrigin: "https://example.invalid" },
    request: { system: "完整系统文本", messages: [], tools: [], sampling: {} },
    response: { outputText: "全文", toolCalls: [], truncated: false },
  };
  store.write(record); await store.close();
  assert.deepEqual(modelTraceRecordSchema.parse(record), record);
  const result = await reader.list();
  assert.equal(result.badCount, 0); assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0]!.record, record);
  assert.deepEqual(await reader.read(result.records[0]!.fileName), record);

  const external = join(dir, "outside");
  await mkdir(external);
  const name = "120000-000-agent-chat-000001.json";
  await writeFile(join(external, name), JSON.stringify(record));
  await symlink(external, join(root, "2020-01-01"));
  assert.equal(await reader.read(`2020-01-01.${name}`), undefined);
  assert.equal((await reader.list()).badCount, 1);
  const linkedRoot = join(dir, "linked-traces");
  await symlink(root, linkedRoot);
  assert.equal(await createModelTraceReader(linkedRoot).read(result.records[0]!.fileName), undefined);
  await assert.rejects(createModelTraceReader(linkedRoot).list());
  assert.deepEqual(await readdir(external), [name], "reader must not change external targets");
});
