import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createConversation } from "../../src/features/conversation/conversation-service.js";
import { buildCompactionSettings } from "../../src/adapters/pi/session-factory.js";
import { createWorkspaceEvents } from "../../src/features/workspace/workspace-events.js";
import type { ConversationDependencies, ConversationExecution, ConversationHistoryPort } from "../../src/features/conversation/ports.js";
import type { ConversationEvent, ConversationRecords, ExecutionEvent } from "../../src/features/conversation/types.js";
import type { SessionStatus } from "../../src/features/workspace/session-status.js";
import { createMessageFeedbackFixture } from "../support/message-session.js";

/** 这里只替换 port 测生命周期，不模拟 agent loop；真实 pi/HTTP 仍由集成套件保护。 */
const fixture = async (t: TestContext) => {
  const calls: string[] = [];
  let listener: (event: ExecutionEvent) => void = () => {};
  const history: ConversationHistoryPort = {
    history: () => [], records: () => ({ turns: [], results: new Map() }), checkpoint: () => "leaf",
    piSessionId: () => "unit-session", messageFacts: () => [],
    omitTurn: () => { calls.push("omit"); }, appendTurn: (turn) => { calls.push("turn:" + JSON.stringify(turn)); },
    appendNotification: (notification) => { calls.push("notification:" + notification.text); },
    appendResult: (result) => { calls.push(result.status); }, restoreIfNoUser: () => { calls.push("restore"); },
  };
  const session: ConversationExecution = {
    prompt: async (text, images) => { calls.push("prompt:" + text + JSON.stringify(images ?? [])); listener({ type: "assistant_end", reason: "stop", text: "answer" }); },
    waitForIdle: async () => { calls.push("idle"); }, abort: async () => { calls.push("abort"); },
    dispose: () => { calls.push("dispose"); }, syncContext: () => { calls.push("sync"); },
    subscribe: (next) => { listener = next; return () => { calls.push("unsubscribe"); }; },
  };
  const messageFeedback = await createMessageFeedbackFixture({
    sessionId: "main", piSessionId: "unit-session", facts: history.messageFacts,
  });
  t.after(messageFeedback.cleanup);
  const dependencies: ConversationDependencies = { history, messages: messageFeedback.messages, openSession: async () => session };
  return { calls, session, dependencies };
};
const input = { sessionId: "main", runId: "run", expectedRevision: "leaf", message: { id: "user", content: "hello" } };

test("coordinator finishes only after pi idle and persisted result and then releases its sole lock", async (t) => {
  const { calls, dependencies } = await fixture(t);
  const conversation = createConversation({ configured: true, runTimeoutMs: 5000 }, dependencies);
  const events: ConversationEvent[] = [];
  await conversation.run(input, (event) => {
    if (event.type === "run_finished") assert.deepEqual(calls.slice(-2), ["idle", "completed"]);
    events.push(event);
  });
  assert.equal(events.at(-1)?.type, "run_finished");
  assert.equal(conversation.isRunning(), false);
  assert.deepEqual(calls.slice(-2), ["unsubscribe", "dispose"]);
});

for (const previousStatus of ["aborted", "completed"] as const) {
  test(`coordinator submits the new user prompt with an execution boundary only after ${previousStatus}`, async (t) => {
    const { dependencies, session } = await fixture(t);
    const records: ConversationRecords = {
      turns: [{ runId: "old-run", userId: "old-user", assistantId: "old-assistant", text: "old task" }],
      results: new Map([["old-run", { runId: "old-run", status: previousStatus }]]),
    };
    dependencies.history.records = () => records;
    dependencies.history.appendTurn = (turn) => { records.turns.push(turn); };
    let receivedPrompt: string | undefined;
    // 通过执行 port 捕获实际提交文本，同时保留正常终态事件，避免只验证纯函数的返回值。
    const prompt = session.prompt;
    dependencies.openSession = async () => ({
      ...session,
      prompt: async (text, images) => { receivedPrompt = text; await prompt(text, images); },
    });
    const conversation = createConversation({ configured: true, runTimeoutMs: 5000 }, dependencies);
    const events: ConversationEvent[] = [];
    await conversation.run({ ...input, message: { id: "new-user", content: "Good evening" } }, (event) => events.push(event));
    assert.equal(events.at(-1)?.type, "run_finished");
    assert.ok(receivedPrompt);
    assert.ok(receivedPrompt.endsWith("Good evening"));
    if (previousStatus === "aborted") {
      assert.match(receivedPrompt, /^Execution boundary for this turn:/);
      assert.ok(receivedPrompt.indexOf("Execution boundary") < receivedPrompt.indexOf("Good evening"));
    } else assert.doesNotMatch(receivedPrompt, /Execution boundary for this turn:/);
  });
}

test("coordinator records attachment metadata and passes images in the same SDK prompt", async (t) => {
  const { calls, dependencies } = await fixture(t);
  const conversation = createConversation({ configured: true, runTimeoutMs: 5000 }, dependencies);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("ok"),
  ]);
  await conversation.run({
    sessionId: "main", runId: "image-run", expectedRevision: "leaf",
    message: {
      id: "user", content: "",
      attachments: [{
        id: "image_1", name: "随机码.png", mimeType: "image/png",
        dataBase64: png.toString("base64"),
      }],
    },
  }, () => {});
  const turnCall = calls.find((call) => call.startsWith("turn:"));
  const promptCall = calls.find((call) => call.startsWith("prompt:"));
  assert.ok(turnCall);
  assert.ok(promptCall);
  assert.match(turnCall, /"attachments":\[/);
  assert.doesNotMatch(turnCall, new RegExp(png.toString("base64")));
  assert.match(promptCall, /UNTRUSTED USER IMAGE/);
  assert.match(promptCall, new RegExp(png.toString("base64")));
});

test("trigger has an explicit timeout only when requested and shares the lock with client runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, dependencies, session } = await fixture(t);
  let release!: () => void;
  const opened = new Promise<ConversationExecution>((resolve) => { release = () => resolve(session); });
  dependencies.openSession = () => opened;
  const conversation = createConversation({ configured: true, runTimeoutMs: 1 }, dependencies);
  const pending = conversation.trigger("scheduled", "job");
  t.mock.timers.tick(1000);
  assert.equal(conversation.isRunning(), true);
  await assert.rejects(conversation.run(input, () => {}), { code: "session_locked" });
  assert.deepEqual(await conversation.trigger("other", "other-job"), { status: "failed", text: "busy" });
  assert.equal(await conversation.cancel("STOPPED", "not-owner"), false);
  release();
  assert.deepEqual(await pending, { status: "completed", text: "answer" });
  assert.equal(calls.includes("abort"), false);
  assert.equal(conversation.isRunning(), false);
});

test("client early cancellation after opening never records a replacement turn", async (t) => {
  const { calls, dependencies, session } = await fixture(t);
  let release!: () => void;
  dependencies.openSession = () => new Promise((resolve) => { release = () => resolve(session); });
  const conversation = createConversation({ configured: true, runTimeoutMs: 5000 }, dependencies);
  const events: ConversationEvent[] = [];
  const pending = conversation.run(input, (event) => events.push(event));
  const cancelled = conversation.cancel();
  release();
  await pending;
  assert.equal(await cancelled, true);
  assert.equal(calls.includes("turn"), false);
  assert.equal(calls.includes("sync"), false);
  assert.deepEqual(events.at(-1), { type: "run_error", code: "STOPPED", message: "Run stopped by user" });
});

test("attachStream replays buffered text and detaching does not abort the active run", async (t) => {
  const { dependencies, session } = await fixture(t);
  let listener: (event: ExecutionEvent) => void = () => {};
  let finishPrompt!: () => void;
  const promptDone = new Promise<void>((resolve) => { finishPrompt = resolve; });
  dependencies.openSession = async () => ({
    ...session,
    subscribe: (next) => { listener = next; return () => {}; },
    prompt: async () => {
      listener({ type: "turn_start" });
      listener({ type: "text_delta", delta: "first " });
      await promptDone;
      listener({ type: "text_delta", delta: "second" });
      listener({ type: "assistant_end", reason: "stop", text: "first second" });
    },
  });
  const conversation = createConversation({ configured: true, runTimeoutMs: 5000 }, dependencies);
  const initialEvents: ConversationEvent[] = [];
  const handle = conversation.startRun(input, (event) => initialEvents.push(event));
  await new Promise((resolve) => setImmediate(resolve));
  handle.detach();
  const attachedEvents: ConversationEvent[] = [];
  const attached = conversation.attachStream(input.runId, (event) => attachedEvents.push(event));
  assert.ok(attached);
  finishPrompt();
  await attached.done;
  assert.equal(conversation.isRunning(), false);
  assert.equal(attachedEvents[0]?.type, "run_started");
  assert.deepEqual(
    attachedEvents.filter((event) => event.type === "text_delta").map((event) => event.delta),
    ["first ", "second"],
  );
  assert.equal(attachedEvents.at(-1)?.type, "run_finished");
  assert.equal(conversation.attachStream(input.runId, () => {}), null);
});

test("compaction settings scale with model context window without reserving half of smaller windows", () => {
  const s32k = buildCompactionSettings(32768, 4096);
  assert.equal(s32k.enabled, true);
  assert.equal(s32k.reserveTokens, 4915);
  assert.equal(s32k.keepRecentTokens, 3932);

  const s128k = buildCompactionSettings(128000, 16384);
  assert.equal(s128k.reserveTokens, 19200);
  assert.equal(s128k.keepRecentTokens, 15360);

  const s256k = buildCompactionSettings(262144, 16384);
  assert.equal(s256k.reserveTokens, 32768);
  assert.equal(s256k.keepRecentTokens, 16384);
});

test("run timeout records lastRun as failed with explicit timeout label instead of cancelled", async (t) => {
  const { dependencies, session } = await fixture(t);
  const events = createWorkspaceEvents();
  const persistedStatuses: SessionStatus[] = [];
  dependencies.history.appendAgentStatus = (status) => { persistedStatuses.push(status); };
  dependencies.history.sessionStatuses = () => persistedStatuses;
  let rejectPrompt: ((error: Error) => void) | undefined;
  dependencies.beginStatus = (init) => events.beginRun(init);
  dependencies.openSession = async () => ({
    ...session,
    prompt: () => new Promise<void>((_resolve, reject) => { rejectPrompt = reject; }),
    abort: async () => { rejectPrompt?.(new Error("aborted")); },
    waitForIdle: async () => {},
  });
  const conversation = createConversation({ configured: true, runTimeoutMs: 40 }, dependencies);
  const runEvents: ConversationEvent[] = [];
  const handle = conversation.startRun(
    { ...input, runId: "timeout-run" },
    (event) => runEvents.push(event),
  );
  await handle.done;
  const terminal = runEvents.at(-1);
  assert.equal(terminal?.type, "run_error");
  if (terminal?.type === "run_error") assert.equal(terminal.code, "TIMEOUT");
  const snap = await conversation.snapshot();
  assert.equal(snap.lastRun?.status, "failed");
  assert.equal(snap.lastRun?.label, "处理超时，未生成完整回复");
});

test("plain chat turns stay out of persisted executionRuns while executionStatus still resolves from cache and records fallback", async (t) => {
  const { dependencies } = await fixture(t);
  const events = createWorkspaceEvents();
  const persistedStatuses: SessionStatus[] = [];
  const records: ConversationRecords = { turns: [], results: new Map() };
  dependencies.history.records = () => records;
  dependencies.history.appendTurn = (turn) => { records.turns.push(turn); };
  dependencies.history.appendResult = (result) => { records.results.set(result.runId, result); };
  dependencies.history.appendAgentStatus = (status) => { persistedStatuses.push(status); };
  dependencies.history.sessionStatuses = () => persistedStatuses;
  dependencies.beginStatus = (init) => events.beginRun(init);

  const conversation = createConversation({ configured: true, runTimeoutMs: 5000 }, dependencies);
  await conversation.run({ ...input, runId: "plain-run-1" }, () => {});

  assert.equal(persistedStatuses.length, 0);
  assert.equal(conversation.executionRuns().length, 0);
  assert.equal(conversation.executionStatus("plain-run-1")?.status, "succeeded");
  assert.equal((await conversation.snapshot()).lastRun?.runId, "plain-run-1");

  // Re-opening after restart (empty in-memory cache) still resolves single-run status from turn+result records,
  // while keeping executionRuns clean of plain-text Q&A entries.
  const reopened = createConversation({ configured: true, runTimeoutMs: 5000 }, dependencies);
  assert.equal(reopened.executionRuns().length, 0);
  const fallback = reopened.executionStatus("plain-run-1");
  assert.equal(fallback?.status, "succeeded");
  assert.equal(fallback?.title, "hello");
});
