import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createConversation } from "../../src/features/conversation/conversation-service.js";
import type { ConversationDependencies, ConversationExecution, ConversationHistoryPort } from "../../src/features/conversation/ports.js";
import type { ConversationEvent, ConversationRecords, ExecutionEvent } from "../../src/features/conversation/types.js";
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
