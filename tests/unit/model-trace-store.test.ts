import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModelTraceStore,
  redactTraceText,
  type ModelTraceRecord,
} from "../../src/adapters/model-trace/store.js";

const record = (index: number, overrides: Partial<ModelTraceRecord["meta"]> = {}): ModelTraceRecord => ({
  meta: {
    startedAt: new Date(Date.now() - 1000).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1000,
    agentId: "local-main",
    kind: "chat",
    upstreamOrigin: "https://model.example.com",
    httpStatus: 200,
    ...overrides,
  },
  request: {
    system: `system prompt ${index}`,
    messages: [{ role: "system", content: `system prompt ${index}` }, { role: "user", content: `hello ${index}` }],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    sampling: { model: "test-model", stream: true },
  },
  response: { outputText: `reply ${index}`, toolCalls: [], finishReason: "stop", streamDone: true, truncated: false },
});

const traceFiles = async (dir: string) => {
  const days = (await readdir(dir)).sort();
  const files: string[] = [];
  for (const day of days) files.push(...(await readdir(join(dir, day))).sort().map((name) => `${day}/${name}`));
  return files;
};

test("store writes one ASCII-named JSON file per record under the day directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-trace-store-"));
  try {
    const store = createModelTraceStore({ dir, maxTotalBytes: 1024 * 1024 * 1024 });
    store.write(record(1));
    store.write(record(2, { agentId: "news-internal", kind: "information:recommendations" }));
    await store.close();

    const files = await traceFiles(dir);
    assert.equal(files.length, 2);
    const [first, second] = files;
    assert.match(first!, /^\d{4}-\d{2}-\d{2}\/\d{6}-\d{3}-local-main-chat-\d{6}\.json$/);
    // kind 中的 ":" 在文件名里折叠为 "-"，且全文件名为 ASCII 安全字符。
    assert.match(second!, /^\d{4}-\d{2}-\d{2}\/\d{6}-\d{3}-news-internal-information-recommendations-\d{6}\.json$/);
    assert.ok(!files.some((name) => name.includes(":")));

    const parsed = JSON.parse(await readFile(join(dir, first!), "utf8")) as ModelTraceRecord;
    assert.equal(parsed.meta.kind, "chat");
    assert.equal(parsed.meta.agentId, "local-main");
    assert.equal(parsed.meta.upstreamOrigin, "https://model.example.com");
    assert.equal(parsed.request?.system, "system prompt 1");
    assert.deepEqual(parsed.request?.sampling, { model: "test-model", stream: true });
    assert.equal(parsed.response?.outputText, "reply 1");

    // 原子写完成后不残留临时文件。
    for (const file of files) assert.ok(!file.endsWith(".tmp"));
    const dirEntries = (await readdir(join(dir, files[0]!.split("/")[0]!))).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(dirEntries, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store redacts known model key strings everywhere in the serialized document", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-trace-store-"));
  try {
    const sampleKey = "sk-live-abcdef123456 tail";
    assert.equal(redactTraceText(`Bearer ${sampleKey} tail`, [sampleKey]), "Bearer [REDACTED] tail");
    // 短于 8 位的值不参与替换，避免误伤普通子串。
    assert.equal(redactTraceText("short key", ["short"]), "short key");

    const secret = sampleKey;
    const store = createModelTraceStore({ dir, maxTotalBytes: 1024 * 1024 * 1024, secrets: [secret] });
    store.write(record(1, {
      httpStatus: 401,
      extra: { informationRunId: `run-with-${secret}` },
    }));
    await store.close();
    const [file] = await traceFiles(dir);
    const text = await readFile(join(dir, file!), "utf8");
    assert.ok(!text.includes(secret), "trace file must not contain the raw model key");
    assert.ok(text.includes("[REDACTED]"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store evicts oldest files first once total bytes exceed the limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-trace-store-"));
  try {
    // 每条约 2KiB；上限 6KiB 只够保留最近 2-3 条。
    const store = createModelTraceStore({ dir, maxTotalBytes: 6 * 1024 });
    const names: string[] = [];
    for (let index = 0; index < 8; index++) {
      store.write(record(index, { agentId: `agent-${index}` }));
      await store.close();
      const files = await traceFiles(dir);
      names.push(files.at(-1)!);
      // 间隔写入，保证文件名时间戳单调，最旧文件可按名称排序确定。
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    const remaining = await traceFiles(dir);
    assert.ok(remaining.length < 8, "retention must delete some files");
    assert.ok(remaining.length >= 1, "newest file must survive");
    // 保留的是最新写入的文件，被删的是最旧的。
    assert.ok(remaining.includes(names.at(-1)!));
    assert.ok(!remaining.includes(names[0]!));

    let total = 0;
    for (const file of remaining) total += (await stat(join(dir, file))).size;
    assert.ok(total <= 6 * 1024, `total ${total} must stay within the limit`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store write failures never reject and log one sanitized line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-trace-store-"));
  try {
    // 让 traces 根不可用（被普通文件占据），每次写入必然失败。
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, "not a directory");
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
      original(...args.map(() => "[suppressed]"));
    };
    const store = createModelTraceStore({ dir, maxTotalBytes: 1024 * 1024 });
    try {
      store.write(record(1));
      await store.close();
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1, "exactly one sanitized failure line");
    assert.match(String(errors[0]![0]), /\[pi-muse\/model-trace\] trace write failed: ENOTDIR/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
