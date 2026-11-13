import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryRepository } from "../../src/adapters/storage/memory-repository.js";
import { createIdentityRepository } from "../../src/adapters/storage/identity-repository.js";
import {
  parseMemoryMarkdown,
  renderMemoryMarkdown,
} from "../../src/adapters/storage/memory-markdown.js";
import { InvalidDocumentError } from "../../src/adapters/storage/document-schemas.js";
import { createIdentityService } from "../../src/features/identity/identity-service.js";
import { defaultIdentity } from "../../src/features/identity/types.js";
import { createMemoryService } from "../../src/features/memory/memory-service.js";
import type { MemoryItem } from "../../src/features/memory/types.js";

const setup = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "personal-bot-memory-markdown-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const memoryFile = join(directory, "memory.md");
  const identityFile = join(directory, "identity.json");
  const repository = createMemoryRepository(memoryFile);
  const identityRepository = createIdentityRepository(identityFile);
  const identity = createIdentityService(identityRepository);
  return {
    directory, memoryFile, identityFile, repository, identityRepository, identity,
    memory: createMemoryService(repository, identity),
  };
};

const item = (id: string, text = id): MemoryItem => ({
  id, text, source: "test",
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
});

test("memory.md parses the documented line format and ignores headings and blank lines", () => {
  const source = [
    "# 长期记忆",
    "",
    "- [mem_a] 用户偏好深色界面 <!-- source=chat created=2026-11-01T08:00:00.000Z updated=2026-11-01T08:00:00.000Z -->",
    "",
    "# 其它标题",
    "- [mem_b] 家里养了一只金毛 <!-- source=Web UI created=2026-11-02T09:30:00.000Z updated=2026-11-03T10:00:00.000Z -->",
    "",
  ].join("\n");
  assert.deepEqual(parseMemoryMarkdown(source), [
    {
      id: "mem_a", text: "用户偏好深色界面", source: "chat",
      createdAt: "2026-11-01T08:00:00.000Z", updatedAt: "2026-11-01T08:00:00.000Z",
    },
    {
      id: "mem_b", text: "家里养了一只金毛", source: "Web UI",
      createdAt: "2026-11-02T09:30:00.000Z", updatedAt: "2026-11-03T10:00:00.000Z",
    },
  ]);
});

test("memory.md without a trailing comment keeps a memory item complete with explicit fallbacks", () => {
  const parsed = parseMemoryMarkdown("- [mem_a] 手写的一条记忆\n");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].text, "手写的一条记忆");
  assert.equal(parsed[0].source, "manual");
  assert.equal(parsed[0].createdAt, "1970-01-01T00:00:00.000Z");
  assert.equal(parsed[0].updatedAt, "1970-01-01T00:00:00.000Z");
});

test("memory.md rejects malformed lines instead of dropping them", () => {
  const broken = [
    "- [mem_a] 正常文本 <!-- source=chat created=2026-11-01T08:00:00.000Z updated=2026-11-01T08:00:00.000Z -->\n- 不是列表项\n",
    "- [bad id] 文本\n",
    "- [mem_a] \n",
    "- [mem_a]\n",
    "- [mem_a] 文本 <!-- source=chat -->\n",
    "- [mem_a] 文本 <!-- source=chat created=not-a-date updated=not-a-date -->\n",
    "- [mem_a] 文本 <!-- created=2026-11-01T08:00:00.000Z updated=2026-11-01T08:00:00.000Z -->\n",
    "- [mem_a] 文本 <!-- source=chat created=2026-11-01T08:00:00.000Z updated=2026-11-01T08:00:00.000Z\n",
    "- [" + "x".repeat(65) + "] 文本\n",
  ];
  for (const source of broken) {
    assert.throws(
      () => parseMemoryMarkdown(source),
      (error: unknown) => error instanceof InvalidDocumentError && error.message.includes("memory-markdown"),
      `must reject: ${JSON.stringify(source)}`,
    );
  }
});

test("memory.md keeps empty files and heading-only files as an empty memory set", () => {
  assert.deepEqual(parseMemoryMarkdown(""), []);
  assert.deepEqual(parseMemoryMarkdown("\n\n"), []);
  assert.deepEqual(parseMemoryMarkdown("# 长期记忆\n"), []);
  assert.deepEqual(parseMemoryMarkdown("# 长期记忆\n\n"), []);
});

test("memory.md round-trips the full item shape and keeps the write order stable", () => {
  const items = [
    { ...item("mem_a", "第一条"), source: "chat" },
    { ...item("mem_b", "第二条 带 -- 符号"), source: "Web UI" },
    { ...item("mem_c", "第三条 <b>bold</b>"), source: "manual" },
  ];
  const rendered = renderMemoryMarkdown(items);
  assert.match(rendered, /^# 长期记忆\n\n- \[mem_a\] 第一条 <!-- source=chat created=/);
  assert.deepEqual(parseMemoryMarkdown(rendered), items);
  // 顺序即写入顺序，重复渲染结果稳定。
  assert.equal(renderMemoryMarkdown(items), rendered);
  assert.deepEqual(parseMemoryMarkdown(renderMemoryMarkdown([...items].reverse())).map((entry) => entry.id), ["mem_c", "mem_b", "mem_a"]);
});

test("memory.md escapes line breaks and comment openers so one item stays one line", () => {
  const items = [item("mem_a", "第一行\n第二行 <!-- 注释 --> 结尾\\")];
  const rendered = renderMemoryMarkdown(items);
  assert.equal(rendered.split("\n").filter((line) => line.startsWith("- ")).length, 1);
  assert.deepEqual(parseMemoryMarkdown(rendered), items);
});

test("memory writes to memory.md and identity writes to identity.json without overwriting each other", async (t) => {
  const { memoryFile, identityFile, memory, identity } = await setup(t);
  await memory.add("记住深色界面", "chat");
  await identity.save({ name: "茶壶", tone: "concise" });
  const memorySource = await readFile(memoryFile, "utf8");
  const identitySource = await readFile(identityFile, "utf8");
  assert.match(memorySource, /- \[[0-9a-f-]{36}\] 记住深色界面/);
  assert.doesNotMatch(memorySource, /茶壶|concise/);
  assert.deepEqual(JSON.parse(identitySource), { ...defaultIdentity, name: "茶壶", tone: "concise" });
  assert.equal((await stat(memoryFile)).mode & 0o777, 0o600);
  assert.equal((await stat(identityFile)).mode & 0o777, 0o600);

  // 再次写记忆不会动身份文件，反之亦然。
  const before = await readFile(identityFile, "utf8");
  await memory.add("第二条", "chat");
  assert.equal(await readFile(identityFile, "utf8"), before);
});

test("memory.md is missing on start and identity.json falls back to the default identity", async (t) => {
  const { memoryFile, identityFile, repository, identityRepository, memory, identity } = await setup(t);
  assert.deepEqual(await repository.read(), { memories: [] });
  assert.deepEqual(await identityRepository.read(), defaultIdentity);
  assert.deepEqual(await memory.list(), []);
  assert.deepEqual(await identity.get(), defaultIdentity);
  await assert.rejects(stat(memoryFile), { code: "ENOENT" });
  await assert.rejects(stat(identityFile), { code: "ENOENT" });
});

test("a corrupted memory.md fails loudly and keeps the original bytes", async (t) => {
  const { memoryFile, repository, memory } = await setup(t);
  const source = "# 长期记忆\n\n- [mem_a] 好的\n- 坏行\n";
  await writeFile(memoryFile, source);
  await assert.rejects(repository.read(), InvalidDocumentError);
  await assert.rejects(repository.update(() => ({ result: undefined })), InvalidDocumentError);
  assert.equal(await readFile(memoryFile, "utf8"), source);
  await assert.rejects(memory.list(), InvalidDocumentError);
});

test("a corrupted identity.json fails loudly and keeps the original bytes", async (t) => {
  const { identityFile, identityRepository, identity } = await setup(t);
  for (const source of ["{broken", "null", "{}", '{"name":"x"}', '{"name":1,"tone":"warm","avatar":"sky","showChatUpdates":true}', '{"name":"x","tone":"warm","avatar":"sky","showChatUpdates":"yes"}']) {
    await writeFile(identityFile, source);
    await assert.rejects(identityRepository.read(), InvalidDocumentError);
    await assert.rejects(identityRepository.update(() => ({ result: undefined })), InvalidDocumentError);
    assert.equal(await readFile(identityFile, "utf8"), source);
  }
  await assert.rejects(identity.get(), InvalidDocumentError);
});

test("edit and forget hit exactly one id by id and never write on a miss", async (t) => {
  const { memoryFile, memory, repository } = await setup(t);
  const first = await memory.add("第一条", "chat");
  const second = await memory.add("第二条", "chat");
  const edited = await memory.edit(first.id, "  改过的第一条  ");
  assert.equal(edited?.text, "改过的第一条");
  assert.equal(edited?.source, "chat");
  assert.equal(edited?.createdAt, first.createdAt);
  assert.deepEqual((await memory.list()).map((entry) => entry.id), [first.id, second.id]);

  // 未命中不写文件，也不改变已有条目。
  const before = await readFile(memoryFile, "utf8");
  assert.equal(await memory.edit("missing", "忽略"), undefined);
  assert.equal(await readFile(memoryFile, "utf8"), before);
  assert.equal(await memory.forget("missing"), false);
  assert.equal(await readFile(memoryFile, "utf8"), before);

  assert.equal(await memory.forget(second.id), true);
  assert.deepEqual((await memory.list()).map((entry) => entry.id), [first.id]);
  assert.equal(await memory.forget(second.id), false);
  assert.deepEqual((await repository.read()).memories.map((entry) => entry.id), [first.id]);
});

test("memory count and recall semantics stay unchanged after the storage split", async (t) => {
  const { memory, identity } = await setup(t);
  await memory.add("用户喜欢在早晨喝无糖美式咖啡", "chat");
  await memory.add("家里养了一只名叫皮皮的金毛猎犬", "chat");
  await identity.save({ name: "茶壶", tone: "concise" });
  const prompt = await memory.renderForPrompt();
  assert.match(prompt, /## Long-term memory\n2 saved item\(s\) are stored but not loaded into this prompt/);
  assert.doesNotMatch(prompt, /美式咖啡|金毛猎犬/);
  assert.match(prompt, /## Identity settings\n- Assistant name: 茶壶\n- Tone: concise/);
  assert.equal((await memory.recall("我早上习惯喝什么咖啡？")).length, 1);
  assert.equal((await memory.recall("今天外面天气怎么样？")).length, 0);
  assert.equal((await memory.recall("   ")).length, 0);
});
