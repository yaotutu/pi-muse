import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createMessageFeedbackRepository } from "../../src/adapters/storage/message-feedback-repository.js";
import {
  MESSAGE_FEEDBACK_EVENTS_TABLE,
  MESSAGE_FEEDBACK_STATES_TABLE,
  messageFeedbackModule,
} from "../../src/adapters/storage/message-feedback-schema.js";
import { openSqliteDatabase, type ManagedSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules, SQLITE_MODULE_LEDGER_TABLE } from "../../src/adapters/storage/sqlite-modules.js";
import {
  createMessageFeedbackSession,
  MessageFeedbackDomainError,
  projectFeedback,
  projectFeedbackMap,
} from "../../src/features/messages/service.js";
import type { MessageExecutionFact, MessageFeedbackDocument, ProjectedMessage } from "../../src/features/messages/types.js";

const openFixture = async (t: TestContext, prefix: string, registerModule = true) => {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const file = join(directory, "main.sqlite");
  const managed = await openSqliteDatabase(file);
  if (registerModule) {
    ensureSqliteModules(managed, [messageFeedbackModule]);
  }
  t.after(async () => {
    await managed.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file, managed };
};

const totalChanges = (managed: ManagedSqliteDatabase): number =>
  Number((managed.database.prepare("SELECT total_changes() AS count").get() as { count: number }).count);

const makeFact = (
  id: string,
  role: "user" | "assistant",
  overrides: Partial<MessageExecutionFact> = {},
): MessageExecutionFact => ({
  id,
  role,
  createdAt: "2026-11-23T08:00:00.000Z",
  source: "chat",
  runId: "run-1",
  jobId: null,
  notificationId: null,
  subagentId: null,
  feedbackAvailable: true,
  ...overrides,
});

test("message_feedback module registers schema ledger entry and tables, failing closed when unregistered", async (t) => {
  const { managed } = await openFixture(t, "pi-muse-msg-fb-ledger");
  const row = managed.database
    .prepare(`SELECT module, version FROM ${SQLITE_MODULE_LEDGER_TABLE} WHERE module = ?`)
    .get("message_feedback") as { module: string; version: number } | undefined;
  assert.deepEqual(
    row ? { module: row.module, version: row.version } : undefined,
    { module: "message_feedback", version: 1 },
  );

  const tables = managed.database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'message_feedback_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    tables.map((item) => item.name),
    [MESSAGE_FEEDBACK_EVENTS_TABLE, MESSAGE_FEEDBACK_STATES_TABLE],
  );

  const unregistered = await openFixture(t, "pi-muse-msg-fb-unregistered", false);
  const brokenRepo = createMessageFeedbackRepository(unregistered.managed);
  await assert.rejects(
    brokenRepo.read("main", "pi-1"),
    /missing schema ledger|not registered/,
  );
});

test("append-only events, indexed state projection, neutral cleanup and no-op diff optimization work on SQLite", async (t) => {
  const { managed } = await openFixture(t, "pi-muse-msg-fb-events");
  const repository = createMessageFeedbackRepository(managed);
  const facts: MessageExecutionFact[] = [
    makeFact("u-1", "user"),
    makeFact("a-1", "assistant"),
    makeFact("u-2", "user"),
    makeFact("a-running", "assistant", { runId: "run-active" }),
    makeFact("a-unavailable", "assistant", { feedbackAvailable: false }),
  ];
  const session = createMessageFeedbackSession({
    sessionId: "main",
    piSessionId: () => "pi-1",
    facts: () => facts,
    repository,
  });

  // 1. 五类事件 + 双表同步
  await session.setReaction("pi-1", "a-1", "like");
  await session.setSaved("pi-1", "a-1", true);
  const added = await session.addComment("pi-1", "a-1", "  保留这条回复  ");
  const commentId = added.comments[0]!.id;
  await session.editComment("pi-1", "a-1", commentId, "修改后的评价");
  await session.setReaction("pi-1", "u-2", "like");
  await session.setReaction("pi-1", "u-1", "dislike");
  await session.setSaved("pi-1", "u-1", true);
  const u1Comment = (await session.addComment("pi-1", "u-1", "临时备注")).comments[0]!.id;

  const afterFeedback = await session.get("a-1", "pi-1");
  assert.equal(afterFeedback.reaction, "like");
  assert.equal(afterFeedback.saved, true);
  assert.equal(afterFeedback.comments[0]?.text, "修改后的评价");

  // 2. 幂等重复操作不写入数据库
  const changesBeforeNoop = totalChanges(managed);
  await session.setReaction("pi-1", "a-1", "like");
  await session.setSaved("pi-1", "a-1", true);
  await session.editComment("pi-1", "a-1", commentId, "修改后的评价");
  assert.equal(totalChanges(managed), changesBeforeNoop);

  // 3. 回到中性态时从状态表清除，但完整审计事件流保留
  await session.setReaction("pi-1", "u-1", null);
  await session.setSaved("pi-1", "u-1", false);
  await session.deleteComment("pi-1", "u-1", u1Comment);

  const u1State = managed.database
    .prepare(`SELECT COUNT(*) AS count FROM ${MESSAGE_FEEDBACK_STATES_TABLE} WHERE message_id = 'u-1'`)
    .get() as { count: number };
  assert.equal(u1State.count, 0);
  const u1Events = await session.events("u-1", "pi-1");
  assert.deepEqual(
    u1Events.map((event) => event.type),
    ["reaction_changed", "saved_changed", "comment_added", "reaction_changed", "saved_changed", "comment_deleted"],
  );

  // 4. 条件列表筛选与运行中消息隐藏
  assert.deepEqual((await session.list("pi-1", { saved: true })).map((item) => item.messageId), ["a-1"]);
  assert.deepEqual((await session.list("pi-1", { reaction: "like" })).map((item) => item.messageId).sort(), ["a-1", "u-2"]);
  assert.deepEqual((await session.list("pi-1", { saved: true, reaction: "like" })).map((item) => item.messageId), ["a-1"]);
  assert.deepEqual((await session.list("pi-1", { saved: false, reaction: "like" })).map((item) => item.messageId), ["u-2"]);
  assert.deepEqual((await session.list("pi-1")).map((item) => item.messageId).sort(), ["a-1", "u-2"]);

  await session.setSaved("pi-1", "a-running", true);
  session.setActiveRun("run-active");
  assert.deepEqual((await session.list("pi-1", { saved: true })).map((item) => item.messageId), ["a-1"]);
  await assert.rejects(
    session.get("a-running", "pi-1"),
    (err: unknown) => err instanceof MessageFeedbackDomainError && err.code === "NOT_FOUND",
  );
  session.setActiveRun(null);
  assert.deepEqual((await session.list("pi-1", { saved: true })).map((item) => item.messageId).sort(), ["a-1", "a-running"]);

  await assert.rejects(
    session.list("stale-pi-session"),
    (err: unknown) => err instanceof MessageFeedbackDomainError && err.code === "SESSION_CONFLICT",
  );
  await assert.rejects(
    session.setSaved("pi-1", "a-unavailable", true),
    (err: unknown) => err instanceof MessageFeedbackDomainError && err.code === "NOT_FOUND",
  );
});

test("restart persistence, removeSession isolation and fail-closed validation hold on SQLite", async (t) => {
  const { file, managed } = await openFixture(t, "pi-muse-msg-fb-lifecycle");
  const repo = createMessageFeedbackRepository(managed);
  const otherSessionId = "00000000-0000-4000-8000-000000000002";

  const mainSession = createMessageFeedbackSession({
    sessionId: "main",
    piSessionId: () => "pi-main",
    facts: () => [makeFact("m-1", "assistant")],
    repository: repo,
  });
  const otherSession = createMessageFeedbackSession({
    sessionId: otherSessionId,
    piSessionId: () => "pi-other",
    facts: () => [makeFact("o-1", "assistant")],
    repository: repo,
  });

  await mainSession.setSaved("pi-main", "m-1", true);
  await otherSession.setReaction("pi-other", "o-1", "like");
  await managed.close();

  const reopened = await openSqliteDatabase(file);
  t.after(() => reopened.close());
  const reopenedRepo = createMessageFeedbackRepository(reopened);
  await reopenedRepo.validateAll();

  const mainDoc = await reopenedRepo.read("main", "pi-main");
  assert.equal(mainDoc.events.length, 1);
  assert.equal(mainDoc.events[0]?.type, "saved_changed");
  assert.equal((await reopenedRepo.listStates?.("main", "pi-main", { saved: true }))?.length, 1);

  await reopenedRepo.removeSession("main");
  assert.equal((await reopenedRepo.read("main", "pi-main")).events.length, 0);
  assert.equal((await reopenedRepo.listStates?.("main", "pi-main"))?.length, 0);
  assert.equal((await reopenedRepo.read(otherSessionId, "pi-other")).events.length, 1);
  assert.equal((await reopenedRepo.listStates?.(otherSessionId, "pi-other", { reaction: "like" }))?.length, 1);

  // 损坏的跨列组合应由 validateAll fail-closed 拒绝
  reopened.database
    .prepare(
      `INSERT INTO ${MESSAGE_FEEDBACK_EVENTS_TABLE}
       (id, position, session_id, pi_session_id, message_id, role, type, from_reaction, to_reaction, from_saved, to_saved, at)
       VALUES ('00000000-0000-4000-8000-000000000099', 999, ?, 'pi-other', 'o-1', 'assistant', 'reaction_changed', NULL, 'like', 0, 1, '2026-11-23T08:00:00.000Z')`,
    )
    .run(otherSessionId);
  await assert.rejects(reopenedRepo.validateAll(), /Invalid message feedback row/);
});

test("projectFeedbackMap matches projectFeedback and isolates large-batch session.project results", async (t) => {
  const { managed } = await openFixture(t, "pi-muse-msg-fb-batch-projection");
  const repo = createMessageFeedbackRepository(managed);

  const messageCount = 2000;
  const facts: MessageExecutionFact[] = [];
  const messages: Array<ProjectedMessage & { feedback?: { reaction: string | null; saved: boolean; comments: unknown[] } }> = [];
  for (let i = 0; i < messageCount; i++) {
    const id = `msg-${i}`;
    const role = i % 2 === 0 ? "user" : "assistant";
    facts.push(makeFact(id, role));
    messages.push({ id, role });
  }

  // 制造 1000 条混合事件（含赞/踩变化、收藏切换、评论增删改以及回到中性态的条目）
  const events: MessageFeedbackDocument["events"] = [];
  for (let i = 0; i < 200; i++) {
    const targetId = `msg-${i * 5}`;
    const role = (i * 5) % 2 === 0 ? "user" : "assistant";
    const commentId = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
    const eventBase = { messageId: targetId, role, at: "2026-11-23T08:00:00.000Z" } as const;
    events.push(
      {
        id: `10000000-0000-4000-8000-${String(i * 5 + 1).padStart(12, "0")}`,
        type: "reaction_changed",
        from: null,
        to: "like",
        ...eventBase,
      },
      {
        id: `10000000-0000-4000-8000-${String(i * 5 + 2).padStart(12, "0")}`,
        type: "saved_changed",
        from: false,
        to: true,
        ...eventBase,
      },
      {
        id: `10000000-0000-4000-8000-${String(i * 5 + 3).padStart(12, "0")}`,
        type: "comment_added",
        commentId,
        text: `note-${i}`,
        ...eventBase,
      },
      {
        id: `10000000-0000-4000-8000-${String(i * 5 + 4).padStart(12, "0")}`,
        type: "comment_edited",
        commentId,
        fromText: `note-${i}`,
        toText: `note-edited-${i}`,
        ...eventBase,
      },
      {
        id: `10000000-0000-4000-8000-${String(i * 5 + 5).padStart(12, "0")}`,
        type: i % 4 === 0 ? "saved_changed" : "comment_deleted",
        ...(i % 4 === 0 ? { from: true, to: false } : { commentId, text: `note-edited-${i}` }),
        ...eventBase,
      } as MessageFeedbackDocument["events"][number],
    );
  }
  assert.equal(events.length, 1000);

  await repo.update("main", "pi-batch", () => ({
    document: { schemaVersion: 1, events },
    result: undefined,
  }));

  const stored = await repo.read("main", "pi-batch");
  const mapped = projectFeedbackMap(stored);
  for (let i = 0; i < 200; i++) {
    const id = `msg-${i * 5}`;
    assert.deepEqual(mapped.get(id), projectFeedback(stored, id));
  }

  const session = createMessageFeedbackSession({
    sessionId: "main",
    piSessionId: () => "pi-batch",
    facts: () => facts,
    repository: repo,
  });

  const projected = await session.project(messages);
  assert.equal(projected.length, messageCount);
  assert.equal(projected[0]?.feedback?.reaction, "like");
  assert.equal(projected[0]?.feedback?.saved, false);
  assert.equal(projected[0]?.feedback?.comments.length, 1);
  assert.equal(projected[5]?.feedback?.saved, true);
  assert.deepEqual(projected[5]?.feedback?.comments, []);
  assert.deepEqual(projected[1]?.feedback, { reaction: null, saved: false, comments: [] });

  // 默认反馈对象必须相互独立，修改一个不影响其他消息
  (projected[1]!.feedback!.comments as unknown[]).push({ id: "mutated" });
  assert.deepEqual(projected[2]?.feedback?.comments, []);
});
