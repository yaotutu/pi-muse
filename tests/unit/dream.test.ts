import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createDataLayout,
  sessionDir,
} from "../../src/adapters/storage/data-layout.js";
import { InvalidDocumentError } from "../../src/adapters/storage/document-schemas.js";
import { createDreamPromptPort, createDreamRepository } from "../../src/adapters/storage/dream-repository.js";
import { dreamModule } from "../../src/adapters/storage/dream-schema.js";
import { createMemoryRepository } from "../../src/adapters/storage/memory-repository.js";
import { createIdentityRepository } from "../../src/adapters/storage/identity-repository.js";
import { readProfileFile, writeProfileFile } from "../../src/adapters/storage/profile-files.js";
import { openSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import {
  readAssistantInstructions,
  writeAssistantInstructions,
} from "../../src/adapters/storage/assistant-instructions.js";
import {
  buildDreamInput,
  composePrompt,
  DEFAULT_DREAM_PROMPT,
  fixedRules,
} from "../../src/features/dream/prompt.js";
import {
  appendInstructions,
  parseProposal,
  planProposal,
} from "../../src/features/dream/proposal.js";
import { createDreamScheduler } from "../../src/features/dream/scheduler.js";
import { createDreamService } from "../../src/features/dream/service.js";
import { BATCH_CHARS, sliceWindow, splitBatches } from "../../src/features/dream/window.js";
import { createIdentityService } from "../../src/features/identity/identity-service.js";
import { createMemoryService } from "../../src/features/memory/memory-service.js";

const setup = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "personal-bot-dream-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const layout = createDataLayout(dir);
  await mkdir(sessionDir(layout, "main"), { recursive: true, mode: 0o700 });
  const memoryRepo = createMemoryRepository(join(layout.profileDir, "memory.md"));
  const identity = createIdentityService(createIdentityRepository(join(layout.profileDir, "identity.json")), {
    read: (which) => readProfileFile(which === "soul" ? layout.soulFile : layout.userFile),
    write: (which, content, expected) =>
      writeProfileFile(which === "soul" ? layout.soulFile : layout.userFile, content, expected),
  });
  const memory = createMemoryService(memoryRepo, identity);
  // 机器状态在 main.sqlite 的 dream_* 表；提示文本仍是 profile/DREAM.md 文件事实。
  const database = await openSqliteDatabase(join(dir, "main.sqlite"));
  t.after(() => database.close());
  await database.serialize(() => ensureSqliteModules(database, [dreamModule]));
  const repository = Object.assign(
    createDreamRepository(database),
    createDreamPromptPort(layout),
  );
  return { dir, layout, database, memory, identity, repository };
};

test("sliceWindow and splitBatches keep 4k-token overlap across runs and batches", () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    id: `m-${i}`,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    text: `message-${i}-` + "x".repeat(3500),
  }));
  const first = sliceWindow(messages.slice(0, 5), undefined, "compaction summary");
  assert.equal(first.context.length, 0);
  assert.equal(first.fresh.length, 5);
  assert.equal(first.lastId, "m-4");

  // 第二次从 m-4 游标继续：m-4 之前的尾部进入 context，m-5..m-9 进入 fresh。
  const second = sliceWindow(messages, "m-4", "compaction summary");
  assert.ok(second.context.length >= 1 && second.context.length < 5);
  assert.equal(second.context.at(-1)?.id, "m-4");
  assert.deepEqual(second.fresh.map((m) => m.id), ["m-5", "m-6", "m-7", "m-8", "m-9"]);
  assert.equal(second.lastId, "m-9");

  // 游标若因会话重置不存在，回退为从头整理，不静默丢消息。
  const reset = sliceWindow(messages.slice(0, 3), "unknown-cursor");
  assert.equal(reset.fresh.length, 3);

  // 超大批次拆分：后一批 context 取前一批尾部，保持批间重叠。
  const huge = sliceWindow(
    Array.from({ length: 6 }, (_, i) => ({
      id: `big-${i}`,
      role: "user" as const,
      text: "y".repeat(Math.floor(BATCH_CHARS / 2)),
    })),
    undefined,
  );
  const batches = splitBatches(huge);
  assert.ok(batches.length >= 2);
  assert.equal(batches[1]!.context.at(-1)?.id, batches[0]!.fresh.at(-1)?.id);
});

test("proposal planner requires review before modifying shared instructions", () => {
  const formatted = "Always sign as Alex.";
  const parsed = parseProposal({
    changes: [
      { target: "user", text: "喜欢美式咖啡", source: "m1" },
      { target: "soul", text: "回答简短", source: "m1" },
      { target: "instructions", text: "邮件末尾加签名", source: "m2" },
      { target: "memory", op: "add", text: "项目代号 Aurora", source: "m2" },
      { target: "memory", op: "edit", id: "missing-id", text: "bad", source: "m2" },
      { target: "pending", suggestedTarget: "memory", text: "不确定归属", source: "m3" },
    ],
  });
  assert.ok(parsed);

  // 全局资料和指令需用户确认，不能由整理轮直接写入。
  const plan = planProposal(parsed, {
    existingMemoryIds: new Set(),
  });
  assert.deepEqual(
    plan.apply.map((c) => c.target),
    ["memory"],
  );
  assert.deepEqual(
    plan.pending.map((p) => [p.suggestedTarget, p.reason]),
    [
      ["user", "global_from_session"],
      ["soul", "global_from_session"],
      ["instructions", "global_from_session"],
      ["memory", "ambiguous"],
    ],
  );
  assert.equal(plan.rejected.length, 1);
  assert.equal(plan.rejected[0]?.reason, "unknown memory id");

  // 行级去重：重复追加同一句不会膨胀文本。
  const once = appendInstructions(formatted, "邮件末尾加签名");
  assert.equal(appendInstructions(once, "邮件末尾加签名"), once);

  // 多行完整块去重：重复追加相同多行块不膨胀文本，避免 partial 失败重跑时堆叠
  const multiline = "### 规则列表\n- 规则一：使用中文\n- 规则二：简洁回答";
  const withMulti = appendInstructions(formatted, multiline);
  assert.ok(withMulti.includes(multiline));
  assert.equal(appendInstructions(withMulti, multiline), withMulti);
  assert.equal(appendInstructions(withMulti, "  ### 规则列表  \n  - 规则一：使用中文  \n  - 规则二：简洁回答  "), withMulti);
  const differentMulti = "### 其他规则\n- 规则三：始终签名";
  const withBoth = appendInstructions(withMulti, differentMulti);
  assert.notEqual(withBoth, withMulti);
  assert.ok(withBoth.includes(differentMulti));
});

test("global Dream prompt falls back to defaults and fixed safety rules remain separate", () => {
  assert.equal(composePrompt(""),DEFAULT_DREAM_PROMPT);
  assert.equal(composePrompt("  GLOBAL  "),"GLOBAL");
  assert.match(DEFAULT_DREAM_PROMPT,/USER, SOUL, MEMORY, and INSTRUCTIONS are global targets/);
  assert.match(DEFAULT_DREAM_PROMPT,/durable guideline explicitly intended for all conversations/);
  assert.match(DEFAULT_DREAM_PROMPT,/not this conversation's business\s+preferences/);
  const rules = fixedRules();
  assert.match(rules, /Never save credentials/);
  assert.match(rules, /must use target=pending/);
  assert.match(rules, /Do not copy a local preference or a one-off request to a shared target/);
  assert.match(rules, /If that edit\/delete is uncertain, omit it entirely/);
  const input = buildDreamInput(
    {
      summary: "summary-text",
      context: [{ id: "c1", role: "user", text: "old" }],
      fresh: [{ id: "f1", role: "user", text: "new" }],
      lastId: "f1",
    },
    { user: "u", soul: "s", instructions: "i", memories: [{ id: "m1", text: "fact" }] },
  );
  assert.match(input, /Earlier context \(already processed; do not extract from it\)/);
  assert.match(input, /New messages \(extract from these\)/);
});

test("profile files and dream repository enforce strict validation, conditional writes and startup reconciliation", async (t) => {
  const { layout, repository, database } = await setup(t);
  // 1. 仅缺失返回默认，目录当作文件读取必须抛 EISDIR，不伪装成空串。
  assert.equal(await readProfileFile(layout.userFile), "");
  await assert.rejects(readProfileFile(layout.sessionsDir), { code: "EISDIR" });

  // 2. 条件写入：版本匹配才写，版本不匹配返回 false 且保留用户新内容。
  assert.equal(await writeProfileFile(layout.userFile, "v1", ""), true);
  assert.equal(await writeProfileFile(layout.userFile, "stale-dream", ""), false);
  assert.equal(await readProfileFile(layout.userFile), "v1");
  const instFile = layout.assistantInstructionsFile;
  assert.equal(await writeAssistantInstructions(instFile, "inst-v1", ""), true);
  assert.equal(await writeAssistantInstructions(instFile, "stale", ""), false);
  assert.equal(await readAssistantInstructions(instFile), "inst-v1");

  // 3. 默认状态：默认开启，无游标与待决项；读取不产生额外数据行，也不写 dream.json。
  assert.deepEqual(await repository.read(), { enabled: true, cursors: {}, pending: [] });
  assert.equal((database.database.prepare("SELECT COUNT(*) AS total FROM dream_cursors").get() as { total: number }).total, 0);
  assert.equal((database.database.prepare("SELECT COUNT(*) AS total FROM dream_pending").get() as { total: number }).total, 0);
  await assert.rejects(stat(join(layout.profileDir, "dream.json")), { code: "ENOENT" });
  // 提示文本端口读写 profile/DREAM.md，不进数据库。
  assert.equal(await repository.readGlobalPrompt(), "");
  await repository.writeGlobalPrompt("# dream rules");
  assert.equal(await readProfileFile(layout.dreamFile), "# dream rules");

  // 4. 损坏的行必须在读取时抛 InvalidDocumentError("dream")，不静默过滤。
  const statement = database.database.prepare("UPDATE dream_state SET last_run_json = ?");
  for (const bad of [
    "{broken",
    '{"at":"2026-10-20T00:00:00.000Z","status":"running","changed":[],"processed":2,"schemaVersion":1}',
    '{"at":"2026-10-20T00:00:00.000Z","status":"running","changed":[],"processed":2,"extra":1}',
    '{"at":"2026-10-20T00:00:00.000Z","status":"weird","changed":[],"processed":2}',
  ]) {
    statement.run(bad);
    await assert.rejects(repository.read(), InvalidDocumentError);
  }
  statement.run(null);

  // 5. 启动校准：崩溃遗留的 running 诚实标记为 failed。
  await repository.update(() => ({
    state: {
      enabled: true,
      cursors: {},
      lastRun: {
        at: "2026-10-20T00:00:00.000Z",
        status: "running",
        changed: [],
        processed: 2,
      },
      pending: [],
    },
    result: undefined,
  }));
  await repository.reconcileOnStart();
  const reconciled = await repository.read();
  assert.equal(reconciled.lastRun?.status, "failed");
  assert.match(reconciled.lastRun?.error ?? "", /Interrupted by service restart/);
});

test("DreamService keeps a pending proposal when its shared profile target changes concurrently", async (t) => {
  const { layout, memory, identity, repository } = await setup(t);
  await mkdir(sessionDir(layout, "00000000-0000-4000-8000-000000000001"), { recursive: true, mode: 0o700 });
  await writeAssistantInstructions(
    layout.assistantInstructionsFile,
    "Keep replies brief.",
  );

  let concurrentUserEdit = false;
  let sessionIds = ["00000000-0000-4000-8000-000000000001"];
  const service = createDreamService({
    repository,
    notes: {
      readUser: () => readProfileFile(layout.userFile),
      writeUserIfUnchanged: async (content, expected) => {
        if (concurrentUserEdit) {
          await writeProfileFile(layout.userFile, "USER-CONCURRENT-EDIT");
        }
        return identity.writeIfUnchanged("user", content, expected);
      },
      readSoul: () => readProfileFile(layout.soulFile),
      writeSoulIfUnchanged: (content, expected) =>
        identity.writeIfUnchanged("soul", content, expected),
      readInstructions: () => readAssistantInstructions(layout.assistantInstructionsFile),
      writeInstructionsIfUnchanged: (content, expected) =>
        writeAssistantInstructions(layout.assistantInstructionsFile, content, expected),
    },
    memory,
    conversations: {
      listSessionIds: async () => sessionIds,
      sessionExists: async (id) => id === "main" || id === "00000000-0000-4000-8000-000000000001",
      isSessionBusy: async () => false,
      readTranscript: async (id) => ({
        messages: [{ id: `${id}-m1`, role: "user", text: "hello" }],
      }),
    },
    propose: async () => ({
      ok: true,
      changes: [
        { target: "user", text: "喜欢乌龙茶", source: "m1" },
        { target: "instructions", text: "统一使用中文回复", source: "m1" },
        { target: "memory", op: "add", text: "常用邮箱 work@example.com", source: "m1" },
      ],
    }),
  });

  // 1. 非主会话 work-mail：仅 memory 直接落盘，instructions 与 user 建议进入 pending，不改全局 USER.md。
  const mailRun = await service.runNow();
  assert.equal(mailRun.ok, true);
  if (mailRun.ok) {
    assert.equal(mailRun.state.lastRun?.status, "completed");
    assert.equal(mailRun.state.cursors["00000000-0000-4000-8000-000000000001"], "00000000-0000-4000-8000-000000000001-m1");
    assert.equal(mailRun.state.pending.length, 2);
    assert.equal(mailRun.state.pending[0]?.reason, "global_from_session");
  }
  assert.equal(await readProfileFile(layout.userFile), "");
  assert.equal(await readAssistantInstructions(layout.assistantInstructionsFile), "Keep replies brief.");
  const instructionsPending = mailRun.ok ? mailRun.state.pending.find((item) => item.suggestedTarget === "instructions")! : undefined;
  assert.ok(instructionsPending);
  assert.equal((await service.resolvePending(instructionsPending.id, { action: "apply" })).ok, true);
  assert.match(await readAssistantInstructions(layout.assistantInstructionsFile), /统一使用中文回复/);
  assert.equal((await memory.list()).length, 1);

  // 2. 用户在页面确认该条 pending 写入 USER.md。
  const pendingId = mailRun.ok ? mailRun.state.pending[0]!.id : "";
  const resolved = await service.resolvePending(pendingId, {
    action: "apply",
    target: "user",
  });
  assert.equal(resolved.ok, true);
  assert.equal(await readProfileFile(layout.userFile), "喜欢乌龙茶");

  // 即使建议来自 main，也必须确认。并发资料编辑不会被旧提案覆盖，待决项保留。
  await writeProfileFile(layout.userFile, "初始用户画像");
  sessionIds = ["main"];
  const mainRun = await service.runNow();
  assert.ok(mainRun.ok);
  assert.equal(mainRun.state.lastRun?.status, "completed");
  assert.equal(mainRun.state.cursors.main, "main-m1");
  assert.equal(await readProfileFile(layout.userFile), "初始用户画像");
  const mainPending = mainRun.state.pending.find((item) => item.suggestedTarget === "user");
  assert.ok(mainPending);
  concurrentUserEdit = true;
  const conflicted = await service.resolvePending(mainPending.id, { action: "apply" });
  assert.equal(conflicted.ok, false);
  assert.equal(await readProfileFile(layout.userFile), "USER-CONCURRENT-EDIT");
  assert.ok((await repository.read()).pending.some((item) => item.id === mainPending.id));

  const scheduler = createDreamScheduler(service, 60_000);
  scheduler.start();
  await scheduler.close();
});
