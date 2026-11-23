import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryRepository } from "../../src/adapters/storage/memory-repository.js";
import { createIdentityRepository } from "../../src/adapters/storage/identity-repository.js";
import { renderMemoryMarkdown } from "../../src/adapters/storage/memory-markdown.js";
import { createIdentityService } from "../../src/features/identity/identity-service.js";
import { defaultIdentity } from "../../src/features/identity/types.js";
import { createMemoryService, MemoryLimitError } from "../../src/features/memory/memory-service.js";
import { renderMemoryPrompt } from "../../src/features/memory/memory-prompt.js";
import type { MemoryItem, MemoryPromptState } from "../../src/features/memory/types.js";

const setup = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "personal-bot-memory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "memory.md");
  const identityFile = join(dir, "identity.json");
  const repository = createMemoryRepository(file);
  const identityRepository = createIdentityRepository(identityFile);
  const identity = createIdentityService(identityRepository);
  return {
    file, identityFile, repository, identityRepository,
    memory: createMemoryService(repository, identity),
    identity,
  };
};
const item = (id: string, text = id): MemoryItem => ({
  id, text, source: "test",
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
});

test("memory and identity live in separate documents and survive repository recreation", async (t) => {
  const { file, identityFile, repository, memory, identity } = await setup(t);
  assert.deepEqual(await memory.list(), []);
  assert.deepEqual(await identity.get(), defaultIdentity);
  const added = await memory.add("  likes tea  ", "Apps UI");
  assert.equal(added.text, "likes tea");
  assert.equal(added.source, "Apps UI");
  assert.ok(added.id);
  assert.ok(Number.isFinite(Date.parse(added.createdAt)));
  const saved = await identity.save({ name: "Tea Bot", tone: "concise" });
  assert.deepEqual(saved, { ...defaultIdentity, name: "Tea Bot", tone: "concise" });
  // 记忆是纯文本清单，身份是配置 JSON：两个文件互不包含对方的字段。
  assert.match(await readFile(file, "utf8"), /^- \[[0-9a-f-]{36}\] likes tea <!-- source=Apps UI created=/m);
  assert.deepEqual(JSON.parse(await readFile(identityFile, "utf8")), { ...defaultIdentity, name: "Tea Bot", tone: "concise" });
  assert.deepEqual(await repository.read(), { memories: [added] });
  assert.deepEqual(await createMemoryRepository(file).read(), { memories: [added] });
  assert.deepEqual(await createIdentityRepository(identityFile).read(), { ...defaultIdentity, name: "Tea Bot", tone: "concise" });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("memory at the 500 item limit rejects new items instead of silently dropping the oldest", async (t) => {
  const { file, memory, identity } = await setup(t);
  const old = Array.from({ length: 500 }, (_, i) => item(`old-${i}`));
  const source = renderMemoryMarkdown(old);
  await writeFile(file, source);
  await assert.rejects(memory.add(" new memory ", "chat"), MemoryLimitError);
  assert.equal(await readFile(file, "utf8"), source, "a rejected add must not touch the file");
  assert.equal((await memory.list())[0].id, "old-0");
  // 腾出位置后才能继续写入；编辑和删除在满额时仍可用。
  const edited = await memory.edit("old-3", " edited ");
  assert.equal(edited?.text, "edited");
  assert.equal(edited?.createdAt, "2026-10-10T00:00:00.000Z");
  assert.equal(edited?.source, "test");
  assert.equal(await memory.edit("missing", "ignored"), undefined);
  assert.equal(await memory.forget("old-0"), true);
  assert.equal(await memory.forget("old-0"), false);
  const added = await memory.add(" new memory ", "chat");
  const list = await memory.list();
  assert.equal(list.length, 500);
  assert.deepEqual(list.at(-1), added);
  assert.deepEqual(await identity.get(), defaultIdentity);
});

test("memory search is case-insensitive, newest-updated first, capped and ignores blank queries", async (t) => {
  const { file, memory } = await setup(t);
  const many = Array.from({ length: 12 }, (_, i) => ({
    ...item(`tea-${i}`, `Likes TEA #${i}`),
    updatedAt: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`,
  }));
  await writeFile(file, renderMemoryMarkdown([...many, item("other", "likes coffee")]));
  const hits = await memory.search("tea");
  assert.equal(hits.length, 10);
  assert.equal(hits[0].id, "tea-11");
  assert.equal(hits[9].id, "tea-2");
  assert.equal((await memory.search("tea", 3)).length, 3);
  assert.equal((await memory.search("tea", 99)).length, 10);
  assert.deepEqual((await memory.search("COFFEE")).map((entry) => entry.id), ["other"]);
  assert.deepEqual(await memory.search("   "), []);
  assert.deepEqual(await memory.search("nothing"), []);
});

test("concurrent memory and identity writes use independent queues without losing updates", async (t) => {
  const { repository, identityRepository, memory, identity } = await setup(t);
  // 同一轮交错发出两个 feature 的修改；两个文档各有自己的写队列，互不覆盖。
  await Promise.all([
    ...Array.from({ length: 30 }, (_, i) => memory.add(`fact-${i}`, "chat")),
    identity.save({ name: "Parallel" }),
    identity.save({ tone: "thoughtful" }),
    identity.save({ avatar: "tea", showChatUpdates: false }),
  ]);
  const state = await repository.read();
  assert.equal(state.memories.length, 30);
  assert.equal(new Set(state.memories.map((entry) => entry.id)).size, 30);
  assert.deepEqual(await identityRepository.read(), {
    name: "Parallel", tone: "thoughtful", avatar: "tea", showChatUpdates: false,
  });
  await Promise.all([
    memory.edit(state.memories[0].id, "edited"),
    memory.forget(state.memories[1].id),
    identity.save({ name: "Renamed" }),
  ]);
  assert.equal((await memory.list()).length, 29);
  assert.equal((await memory.list())[0].text, "edited");
  assert.equal((await identity.get()).name, "Renamed");
});

test("memory rejects malformed entries and identity without rewriting original bytes", async (t) => {
  const { file, identityFile, repository, identityRepository } = await setup(t);
  for (const source of [
    "# 长期记忆\n\n- [ok] 正常 <!-- source=chat created=2026-10-10T00:00:00.000Z updated=2026-10-10T00:00:00.000Z -->\n- 坏行\n",
    "- [bad id] 文本\n",
    "- [ok]\n",
  ]) {
    await writeFile(file, source);
    await assert.rejects(repository.read(), /Invalid memory-markdown document/);
    await assert.rejects(repository.update(() => ({ result: undefined })), /Invalid memory-markdown document/);
    assert.equal(await readFile(file, "utf8"), source);
  }
  for (const source of [
    "{broken",
    '{"memories":[],"identity":{"name":"x"}}',
    '{"name":"x","tone":"warm","avatar":"sky"}',
  ]) {
    await writeFile(identityFile, source);
    await assert.rejects(identityRepository.read(), /Invalid identity document/);
    await assert.rejects(identityRepository.update(() => ({ result: undefined })), /Invalid identity document/);
    assert.equal(await readFile(identityFile, "utf8"), source);
  }
});

test("memory missing edit and missing forget both skip writing", async (t) => {
  const { file, memory } = await setup(t);
  assert.equal(await memory.edit("missing", "ignored"), undefined);
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.equal(await memory.forget("missing"), false);
  await assert.rejects(stat(file), { code: "ENOENT" });
});

test("memory edit changes only the first match, even in a file with duplicate ids", async (t) => {
  const { file, memory } = await setup(t);
  await writeFile(file, renderMemoryMarkdown([item("same", "first"), item("same", "second")]));
  await memory.edit("same", "changed");
  assert.deepEqual((await memory.list()).map((entry) => entry.text), ["changed", "second"]);
});

test("a rejected memory update leaves the writer usable for later calls", async (t) => {
  const { repository, memory } = await setup(t);
  await assert.rejects(repository.update(() => { throw new Error("change failed"); }), /change failed/);
  const added = await memory.add("after failure", "test");
  assert.deepEqual(await memory.list(), [added]);
});

test("memory prompt only announces the count, never the memory text, and rereads settings", async (t) => {
  const state: MemoryPromptState = {
    memories: [item("a", "  secret-fact-text  ")],
    identity: { ...defaultIdentity, name: "Tea Bot", tone: "concise" },
  };
  const original = structuredClone(state);
  const rendered = renderMemoryPrompt(state);
  assert.match(rendered, /## Long-term memory\n1 saved item\(s\) are stored but not loaded into this prompt\. Use memory_search/);
  assert.doesNotMatch(rendered, /secret-fact-text/);
  assert.match(rendered, /\n## Identity settings\n- Assistant name: Tea Bot\n- Tone: concise\n$/);
  assert.deepEqual(state, original);
  assert.equal(renderMemoryPrompt({ memories: [], identity: defaultIdentity }), "");
  assert.equal(renderMemoryPrompt({ memories: [], identity: { ...defaultIdentity, avatar: "other", showChatUpdates: false } }), "");
  const closed = renderMemoryPrompt(state, { includeMemory: false });
  assert.doesNotMatch(closed, /Long-term memory|memory_search/);
  assert.doesNotMatch(closed, /secret-fact-text/);
  assert.match(closed, /Assistant name: Tea Bot/);
  const { memory, identity } = await setup(t);
  assert.equal(await memory.renderForPrompt({ includeMemory: false }), "");
  await identity.save({ name: "New name" });
  await memory.add("fact", "test");
  assert.doesNotMatch(await memory.renderForPrompt({ includeMemory: false }), /memory_search|fact/);
  assert.match(await memory.renderForPrompt({ includeMemory: true }), /memory_search/);
  assert.match(await memory.renderForPrompt(), /Assistant name: New name/);
});

test("memory recall automatically matches relevant memories by Chinese and English terms", async (t) => {
  const { memory } = await setup(t);
  await memory.add("用户喜欢在早晨喝无糖美式咖啡", "chat");
  await memory.add("家里养了一只名叫皮皮的金毛猎犬", "chat");
  await memory.add("日常开发首选语言是 TypeScript", "chat");

  // 中文关键词命中
  const coffeeHits = await memory.recall("请问我早上习惯喝什么咖啡？");
  assert.equal(coffeeHits.length, 1);
  assert.match(coffeeHits[0].text, /美式咖啡/);

  // 中文宠物名称命中
  const dogHits = await memory.recall("狗狗皮皮最近食欲很好");
  assert.equal(dogHits.length, 1);
  assert.match(dogHits[0].text, /皮皮/);

  // 英文词汇与技术栈命中
  const tsHits = await memory.recall("I want to build a new project with TypeScript");
  assert.equal(tsHits.length, 1);
  assert.match(tsHits[0].text, /TypeScript/);

  // 无关问题不命中
  const none = await memory.recall("今天外面天气怎么样？");
  assert.equal(none.length, 0);

  // 空查询返回空
  assert.equal((await memory.recall("   ")).length, 0);
});

test("renderMemoryPrompt formats recalledMemories when provided", async () => {
  const state: MemoryPromptState = {
    memories: [item("m1", "用户养了一只金毛犬叫皮皮")],
    identity: defaultIdentity,
  };
  const rendered = renderMemoryPrompt(state, {
    recalledMemories: [item("m1", "用户养了一只金毛犬叫皮皮")],
  });
  assert.match(rendered, /## Relevant long-term memories \(automatically recalled\)/);
  assert.match(rendered, /- \[m1\] 用户养了一只金毛犬叫皮皮/);
});
