import assert from "node:assert/strict";
import { test } from "node:test";
import { createInformationService } from "../../src/features/information/service.js";
import { defaultInformationState, type InformationRepository, type InformationState } from "../../src/features/information/types.js";
import { parseInformationResult } from "../../src/features/information/result.js";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const emptyFeedback = () => ({ schemaVersion: 1 as const, events: [] });

const fixture = (options?: {
  notify?: (text: string, id: string) => Promise<{ piSessionId: string; messageId: string }>;
  instructions?: () => Promise<string>;
  feedbackRead?: () => Promise<{ schemaVersion: 1; events: never[] }>;
}) => {
  let state = defaultInformationState();
  const repository: InformationRepository = {
    read: async () => structuredClone(state),
    update: async (change) => {
      const changed = await change(structuredClone(state));
      if (changed.state) state = changed.state;
      return changed.result;
    },

    reconcileOnStart: async () => undefined,
    validateAll: async () => undefined,
  };
  const notifications: Array<{ text: string; id: string }> = [];
  const service = createInformationService({
    repository,

    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-1",
        notify: async (text, id) => {
          notifications.push({ text, id });
          return options?.notify?.(text, id) ?? { piSessionId: "session-1", messageId: id };
        },
      },
      release: () => undefined,
    }),
    feedback: { read: options?.feedbackRead ?? (async () => emptyFeedback()) } as never,
    runModel: async () => { throw new Error("unexpected model call"); },
    readInstructions: options?.instructions ?? (async () => ""),
    enabledSkillTexts: async () => [],
  });
  return { repository, service, notifications, state: () => state, readState: () => structuredClone(state) };
};

const resultFor = (itemIds: string[], notifyCount = 1) => ({
  decisions: itemIds.map((id, index) => ({
    itemId: id,
    decision: index < notifyCount ? "notify" as const : "silent" as const,
    reason: "test reason",
  })),
  notifications: notifyCount ? [{ itemIds: itemIds.slice(0, notifyCount), text: "NOTIFY" }] : [],
});

test("information result validator enforces exact coverage, bounds and silent non-publication", () => {
  const good = parseInformationResult(resultFor(["a", "b"]), ["a", "b"]);
  assert.equal(good.decisions.length, 2);
  assert.throws(() => parseInformationResult({ decisions: [], notifications: [] }, ["a"]));
  assert.throws(() => parseInformationResult({
    decisions: [{ itemId: "a", decision: "notify", reason: "x" }],
    notifications: [{ itemIds: ["a"], text: "x".repeat(4001) }],
  }, ["a"]));
  assert.throws(() => parseInformationResult({
    decisions: [
      { itemId: "a", decision: "notify", reason: "x" },
      { itemId: "a", decision: "silent", reason: "x" },
    ],
    notifications: [],
  }, ["a", "a"]));
});

test("recommendation results may select items with empty notifications and no chat coverage", () => {
  const result = parseInformationResult({
    decisions: [
      { itemId: "a", decision: "notify", reason: "material progress" },
      { itemId: "b", decision: "silent", reason: "routine update" },
    ],
    notifications: [],
    learnedNotes: "Prefers concrete releases.",
  }, ["a", "b"], "recommendations");
  assert.deepEqual(result.decisions.map((decision) => decision.decision), ["notify", "silent"]);
  assert.equal(result.learnedNotes, "Prefers concrete releases.");
  assert.throws(() => parseInformationResult({
    decisions: [{ itemId: "a", decision: "notify", reason: "x" }],
    notifications: [{ itemIds: ["a"], text: "chat" }],
    learnedNotes: "",
  }, ["a"], "recommendations"));
});

test("manual and automatic runs contend on one synchronously reserved global slot", async () => {
  const model = deferred<ReturnType<typeof resultFor>>();
  let input: { items: Array<{ id: string }> } | undefined;
  const base = fixture();
  const service = createInformationService({
    repository: base.repository,

    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-1",
        notify: async (_text, id) => ({ piSessionId: "session-1", messageId: id }),
      },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (value) => {
      input = value;
      const result = await model.promise;
      return { ok: true, result };
    },
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  await service.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  const inserted = await service.ingest([
    { source: "rss", externalId: "1", content: "NOTIFY one" },
    { source: "rss", externalId: "2", content: "silent two" },
  ]);
  const first = service.runNow();
  const second = service.runNow();
  await assert.rejects(second, { code: "BUSY" });
  assert.equal(await service.runDue(), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(input);
  model.resolve(resultFor(input.items.map((item) => item.id)));
  const finished = await first;
  assert.equal(finished.run.status, "completed");
  assert.equal(finished.run.itemIds.length, 2);
  assert.equal((await service.listRuns({})).runs.length, 1);
  assert.equal(finished.run.publications[0]?.status, "published");
});

test("processing setup failures mark the run failed and release the global slot", async () => {
  let failInstructions = true;
  let modelCalled = false;
  const base = fixture();
  const service = createInformationService({
    repository: base.repository,

    retainMain: async () => ({
      conversation: { piSessionId: () => "session-1", notify: async (_text, id) => ({ piSessionId: "session-1", messageId: id }) },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async () => { modelCalled = true; return { ok: false, error: "MODEL_REQUEST_FAILED" }; },
    readInstructions: async () => {
      if (failInstructions) throw new Error("instructions I/O failed");
      return "";
    },
    enabledSkillTexts: async () => [],
  });
  await service.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await service.ingest([{ source: "rss", externalId: "1", content: "one" }]);
  await assert.rejects(service.runNow(), /instructions I\/O failed/);
  const state = base.readState();
  assert.equal(state.runs[0]?.status, "failed");
  assert.equal(state.items[0]?.status, "failed");
  assert.equal(modelCalled, false);
  assert.equal(await service.runDue(), false, "global slot must be released");
});

test("cancellation while retain is pending releases the retained agent", async () => {
  const base = fixture();
  const retainGate = deferred<void>();
  let retainStarted = false;
  let retainReleased = false;
  const service = createInformationService({
    repository: base.repository,

    retainMain: async () => {
      retainStarted = true;
      await retainGate.promise;
      return {
        conversation: { piSessionId: () => "session-1", notify: async (_text, id) => ({ piSessionId: "session-1", messageId: id }) },
        release: () => { retainReleased = true; },
      };
    },
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  await service.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await service.ingest([{ source: "rss", externalId: "1", content: "one" }]);
  const running = service.runNow();
  while (!retainStarted) await new Promise((resolve) => setImmediate(resolve));
  const pause = service.pause();
  retainGate.resolve();
  const detail = await running;
  await pause.stopped;
  assert.equal(detail.run.status, "cancelled");
  assert.equal(retainReleased, true);
  pause.resume();
});

test("cancellation after a successful model result preserves model success but fails delivery", async () => {
  const base = fixture();
  const modelGate = deferred<void>();
  let itemId: string | undefined;
  const service = createInformationService({
    repository: base.repository,

    retainMain: async () => ({
      conversation: { piSessionId: () => "session-1", notify: async (_text, id) => ({ piSessionId: "session-1", messageId: id }) },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (input) => {
      itemId = input.items[0]?.id;
      await modelGate.promise;
      return { ok: true, result: resultFor([itemId!]) };
    },
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  await service.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await service.ingest([{ source: "rss", externalId: "1", content: "urgent" }]);
  const running = service.runNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(itemId);
  const cancelling = service.cancel();
  modelGate.resolve();
  await cancelling;
  const detail = await running;
  assert.equal(detail.run.status, "completed");
  assert.equal(detail.run.model?.status, "succeeded");
  assert.equal(detail.run.publications[0]?.status, "failed");
  assert.match(detail.run.publications[0]?.error ?? "", /Cancelled before notification delivery/);
  assert.equal(base.readState().items[0]?.status, "processed");
});

test("per-agent pause barrier is synchronous, nested, and blocks scheduler work", async () => {
  const base = fixture();
  const service = createInformationService({
    repository: base.repository,

    retainMain: async () => ({
      conversation: { piSessionId: () => "session-1", notify: async (_text, id) => ({ piSessionId: "session-1", messageId: id }) },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  await service.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await service.ingest([{ source: "rss", externalId: "1", content: "paused" }]);
  const first = service.pause();
  const second = service.pause();
  await assert.rejects(service.runNow(), { code: "SESSION_PAUSED" });
  assert.equal(await service.runDue(), false);
  assert.equal(await service.nextDue(), false);
  first.resume();
  await assert.rejects(service.runNow(), { code: "SESSION_PAUSED" });
  second.resume();
  assert.equal(await service.nextDue(), true);
});

test("per-agent pause aborts an already started run and waits for exit", async () => {
  const base = fixture();
  const gate = deferred<void>();
  let started = false;
  const service = createInformationService({
    repository: base.repository,

    retainMain: async () => ({
      conversation: { piSessionId: () => "session-1", notify: async (_text, id) => ({ piSessionId: "session-1", messageId: id }) },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (_input, signal) => {
      started = true;
      signal.addEventListener("abort", () => gate.resolve(), { once: true });
      await gate.promise;
      return { ok: false, error: "CANCELLED" };
    },
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  await service.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await service.ingest([{ source: "rss", externalId: "1", content: "urgent" }]);
  const running = service.runNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  const pause = service.pause();
  await pause.stopped;
  const detail = await running;
  assert.equal(detail.run.status, "cancelled");
  assert.equal(base.readState().items[0]?.status, "failed");
  pause.resume();
});

test("pagination uses the last returned row and does not skip equal timestamps", async () => {
  const h = fixture();
  const at = new Date().toISOString();
  const items = Array.from({ length: 5 }, (_value, index) => ({
    id: `item-${index}`,
    source: "rss",
    externalId: String(index),
    content: `content-${index}`,
    receivedAt: at,
    acceptedAt: at,
    status: "pending" as const,
  }));
  // 直接构造 repository 页面，聚焦游标语义；业务排序与列表另有 HTTP 回归。
  let state: InformationState = { ...defaultInformationState(), items };
  const repository: InformationRepository = {
    ...h.repository,
    read: async () => structuredClone(state),
    update: async (change) => (await change(structuredClone(state))).result,
  };
  const service = createInformationService({
    repository,

    retainMain: async () => undefined,
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  const first = await service.listItems({ limit: 2 });
  const second = await service.listItems({ limit: 2, cursor: first.nextCursor });
  const third = await service.listItems({ limit: 2, cursor: second.nextCursor });
  const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id);
  assert.deepEqual(ids, items.map((item) => item.id).sort().reverse());
  assert.equal(third.nextCursor, undefined);
});

test("information cursors are bound to their status filter", async () => {
  const at = new Date().toISOString();
  const items = [0, 1, 2].map((index) => ({
    id: `item-${index}`, source: "rss", externalId: String(index),
    content: `content-${index}`, receivedAt: at, acceptedAt: at,
    status: index === 2 ? "processed" as const : "pending" as const,
  }));
  const repository: InformationRepository = {
    ...h_forState({ ...defaultInformationState(), items }).repository,
  };
  const service = createInformationService({
    repository,

    retainMain: async () => undefined,
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  const pending = await service.listItems({ status: "pending", limit: 1 });
  const pendingNext = await service.listItems({ status: "pending", limit: 1, cursor: pending.nextCursor });
  assert.deepEqual([pending.items[0]?.id, pendingNext.items[0]?.id], ["item-1", "item-0"]);
  const processed = await service.listItems({ status: "processed", limit: 1 });
  await assert.rejects(
    service.listItems({ status: "processed", limit: 1, cursor: pending.nextCursor }),
    { code: "INVALID_INPUT" },
  );
  assert.equal(processed.items[0]?.id, "item-2");
});

test("feedback examples expose current projections and bounded original item context", async () => {
  const at = new Date().toISOString();
  const state: InformationState = {
    ...defaultInformationState(),
    items: [{
      id: "item-1", source: "news", externalId: "x",
      title: "Original title", content: "A".repeat(2500), receivedAt: at, acceptedAt: at, status: "processed",
    }],
    runs: [{
      id: "run-1", itemIds: ["item-1"], status: "completed",
      createdAt: at, startedAt: at,
      publications: [{
        notificationId: "notification-1", itemIds: ["item-1"], text: "summary",
        status: "published", receipt: { notificationId: "notification-1", piSessionId: "session-1", messageId: "notification-1" },
      }],
    }, {
      id: "run-2", itemIds: ["item-1"], status: "completed",
      createdAt: at, startedAt: at,
      publications: [{
        notificationId: "notification-2", itemIds: ["item-1"], text: "latest without feedback",
        status: "published", receipt: { notificationId: "notification-2", piSessionId: "session-1", messageId: "notification-2" },
      }],
    }],
  };
  const repository: InformationRepository = {
    ...h_forState(state).repository,
  };
  const service = createInformationService({
    repository,

    retainMain: async () => ({
      conversation: { piSessionId: () => "session-1", notify: async (_text, id) => ({ piSessionId: "session-1", messageId: id }) },
      release: () => undefined,
    }),
    feedback: {
      read: async () => ({
        schemaVersion: 1,
        events: [
          { id: "e1", type: "comment_added", messageId: "notification-1", role: "assistant", commentId: "c1", text: "old", at },
          { id: "e2", type: "comment_edited", messageId: "notification-1", role: "assistant", commentId: "c1", fromText: "old", toText: "latest", at },
          { id: "e3", type: "reaction_changed", messageId: "notification-1", role: "assistant", from: null, to: "like", at },
        ],
      }),
    } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  const preferences = await service.getPreferences();
  assert.equal(preferences.feedbackExamples.length, 1);
  const example = preferences.feedbackExamples[0]!;
  assert.equal(example.reaction, "like");
  assert.deepEqual(example.comments, ["latest"]);
  assert.equal(example.items[0]?.source, "news");
  assert.equal(example.items[0]?.content.length, 2000);
  assert.equal(example.items[0]?.contentTruncated, true);
});

function h_forState(state: InformationState) {
  let current = structuredClone(state);
  const repository: InformationRepository = {
    read: async () => structuredClone(current),
    update: async (change) => {
      const changed = await change(structuredClone(current));
      if (changed.state) current = changed.state;
      return changed.result;
    },

    reconcileOnStart: async () => undefined,
    validateAll: async () => undefined,
  };
  return { repository };
}

test("feedback storage failures are exposed instead of being treated as no preference", async () => {
  const at = new Date().toISOString();
  const state: InformationState = {
    ...defaultInformationState(),
    items: [{ id: "item-1", source: "rss", externalId: "x", content: "x", receivedAt: at, acceptedAt: at, status: "processed" }],
    runs: [{ id: "run-1", itemIds: ["item-1"], status: "completed", createdAt: at, startedAt: at, publications: [{ notificationId: "n", itemIds: ["item-1"], text: "x", status: "published", receipt: { notificationId: "n", piSessionId: "session-1", messageId: "n" } }] }],
  };
  const service = createInformationService({
    repository: h_forState(state).repository,

    retainMain: async () => ({ conversation: { piSessionId: () => "session-1", notify: async (_text, id) => ({ piSessionId: "session-1", messageId: id }) }, release: () => undefined }),
    feedback: { read: async () => { throw new Error("corrupt feedback"); } } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  await assert.rejects(service.getPreferences(), /corrupt feedback/);
});

test("first run executes initial_summary then transitions to incremental", async () => {
  let state: InformationState = {
    ...defaultInformationState(),
    settings: { enabled: true, batchWindowSeconds: 0, mode: "notifications" },
  };
  const repository: InformationRepository = {
    read: async () => structuredClone(state),
    update: async (change) => {
      const changed = await change(structuredClone(state));
      if (changed.state) state = changed.state;
      return changed.result;
    },

    reconcileOnStart: async () => undefined,
    validateAll: async () => undefined,
  };
  const capturedKinds: string[] = [];
  let instructions = "关注快递取件码";
  const service = createInformationService({
    repository,

    retainMain: async () => ({
      conversation: { piSessionId: () => "session-1", notify: async (_text, id) => ({ piSessionId: "session-1", messageId: id }) },
      release: () => undefined,
    }),
    feedback: { read: async () => ({ schemaVersion: 1 as const, events: [] }) } as never,
    runModel: async (input) => {
      capturedKinds.push(input.analysisKind);
      return {
        ok: true,
        result: {
          decisions: input.items.map((item) => ({ itemId: item.id, decision: "notify" as const, reason: "ok" })),
          notifications: [{ itemIds: input.items.map((item) => item.id), text: "汇总通知" }],
        },
      };
    },
    readInstructions: async () => instructions,
    writeInstructions: async (text) => { instructions = text; },
    enabledSkillTexts: async () => [],
  });

  await service.ingest([
    { source: "sms", externalId: "m1", content: "【顺丰】取件码 1234" },
    { source: "sms", externalId: "m2", content: "【菜鸟】取件码 5678" },
  ]);
  await service.runNow();
  assert.equal(capturedKinds[0], "initial_summary");
  assert.equal(state.initialAnalysisCompleted, true);

  // Subsequent run receives incremental mode
  await service.ingest([{ source: "sms", externalId: "m3", content: "【中通】取件码 9999" }]);
  await service.runNow();
  assert.equal(capturedKinds[1], "incremental");

  // Preferences read/write synchronized with agent instructions
  const prefs = await service.getPreferences();
  assert.equal(prefs.notes, "关注快递取件码");
  await service.savePreferences({ notes: "不再提醒取件码" });
  assert.equal(instructions, "不再提醒取件码");
  const updatedPrefs = await service.getPreferences();
  assert.equal(updatedPrefs.notes, "不再提醒取件码");
});
