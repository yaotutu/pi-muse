import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInformationState } from "../../src/adapters/storage/information-repository.js";
import { createSubmitInformationResultTool } from "../../src/adapters/pi/information-runner.js";
import { createInformationService } from "../../src/features/information/service.js";
import {
  defaultInformationState,
  type InformationBriefingInput,
  type InformationRepository,
  type InformationState,
} from "../../src/features/information/types.js";
import {
  INITIAL_BRIEFING_MAX_LENGTH,
  parseInformationResult,
  parseInitialBriefingResult,
} from "../../src/features/information/result.js";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const emptyFeedback = () => ({ schemaVersion: 1 as const, events: [] });

const fixture = (options?: {
  notify?: (text: string, id: string) => Promise<{ piSessionId: string; messageId: string }>;
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
  let failSkills = true;
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
    enabledSkillTexts: async () => {
      if (failSkills) throw new Error("skills I/O failed");
      return [];
    },
  });
  await service.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await service.ingest([{ source: "rss", externalId: "1", content: "one" }]);
  await assert.rejects(service.runNow(), /skills I\/O failed/);
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
    enabledSkillTexts: async () => [],
  });
  await assert.rejects(service.getPreferences(), /corrupt feedback/);
});

test("first run executes initial_summary then transitions to incremental", async () => {
  let state: InformationState = {
    ...defaultInformationState(),
    settings: { enabled: true, batchWindowSeconds: 0, mode: "notifications" },
    preferences: { notes: "关注快递取件码", learnedNotes: "" },
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

  // Preferences read/write strictly stored in isolated information preferences
  const prefs = await service.getPreferences();
  assert.equal(prefs.notes, "关注快递取件码");
  await service.savePreferences({ notes: "不再提醒取件码" });
  assert.equal(state.preferences.notes, "不再提醒取件码");
  const updatedPrefs = await service.getPreferences();
  assert.equal(updatedPrefs.notes, "不再提醒取件码");
});

test("SMS notification subagent persists and reuses learnedNotes independently from main instructions", async () => {
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
  const capturedPreferences: Array<{ notes: string; learnedNotes: string }> = [];
  let round = 0;
  const service = createInformationService({
    repository,
    retainMain: async () => ({
      conversation: { piSessionId: () => "session-1", notify: async (_text, id) => ({ piSessionId: "session-1", messageId: id }) },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (input) => {
      round++;
      capturedPreferences.push({ ...input.preferences });
      return {
        ok: true,
        result: {
          decisions: input.items.map((item) => ({ itemId: item.id, decision: "notify" as const, reason: "ok" })),
          notifications: [{ itemIds: input.items.map((item) => item.id), text: "短信通知" }],
          learnedNotes: round === 1 ? "用户对银行账单和快递取件码高度敏感" : "用户对银行账单、快递取件码敏感；忽略积分提醒",
        },
      };
    },
    enabledSkillTexts: async () => [],
  });

  await service.savePreferences({ notes: "优先提醒银行与快递" });
  await service.ingest([{ source: "sms", externalId: "sms-1", content: "【顺丰】取件码 1234" }]);
  await service.runNow();

  assert.equal(capturedPreferences[0]?.notes, "优先提醒银行与快递");
  assert.equal(capturedPreferences[0]?.learnedNotes, "");
  assert.equal((await service.getPreferences()).learnedNotes, "用户对银行账单和快递取件码高度敏感");

  await service.ingest([{ source: "sms", externalId: "sms-2", content: "【银行】积分提醒" }]);
  await service.runNow();

  assert.equal(capturedPreferences[1]?.learnedNotes, "用户对银行账单和快递取件码高度敏感");
  assert.equal((await service.getPreferences()).learnedNotes, "用户对银行账单、快递取件码敏感；忽略积分提醒");
});

test("initial bulk import drains all pending batches, rolls learnedNotes, and publishes only one combined notification", async () => {
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
  const sentNotifications: Array<{ text: string; id: string }> = [];
  const rounds: Array<{
    analysisKind: string;
    itemCount: number;
    incomingLearnedNotes: string;
  }> = [];

  const briefingInputs: InformationBriefingInput[] = [];
  const service = createInformationService({
    repository,
    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-1",
        notify: async (text, id) => {
          sentNotifications.push({ text, id });
          return { piSessionId: "session-1", messageId: id };
        },
      },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (input) => {
      const roundIndex = rounds.length + 1;
      rounds.push({
        analysisKind: input.analysisKind,
        itemCount: input.items.length,
        incomingLearnedNotes: input.preferences.learnedNotes,
      });
      const notifyItems = input.items.filter((item) => item.content.includes("ACTIONABLE"));
      return {
        ok: true,
        result: {
          decisions: input.items.map((item) => ({
            itemId: item.id,
            decision: notifyItems.some((entry) => entry.id === item.id) ? "notify" as const : "silent" as const,
            reason: "evaluated",
          })),
          notifications: notifyItems.length
            ? [{ itemIds: notifyItems.map((item) => item.id), text: `批次${roundIndex}待办(${notifyItems.length})` }]
            : [],
          learnedNotes: `画像阶段${roundIndex}`,
        },
      };
    },
    synthesizeBriefing: async (input) => {
      briefingInputs.push(input);
      return {
        ok: true,
        text: `已梳理 ${input.totalScanned} 条历史短信（过滤 ${input.silentCount} 条）：仅剩 ${input.candidates.length} 条关键待办`,
        itemIds: input.candidates.map((candidate) => candidate.itemId),
      };
    },
    enabledSkillTexts: async () => [],
  });

  // 70 historical SMS: items #0 (batch 1), #30 (batch 2), #69 (batch 3) are actionable (30 + 30 + 10)
  const inputs = Array.from({ length: 70 }, (_value, index) => ({
    source: "sms",
    externalId: `hist-${index}`,
    content: (index === 0 || index === 30 || index === 69) ? `ACTIONABLE 短信 ${index}` : `历史促销/过期验证码 ${index}`,
    receivedAt: new Date(Date.UTC(2026, 10, 1, Math.floor(index / 60), index % 60)).toISOString(),
  }));
  await service.ingest(inputs, { bulkImport: true });
  const lastRun = await service.runNow();

  assert.equal(rounds.length, 3);
  assert.deepEqual(rounds, [
    { analysisKind: "initial_summary", itemCount: 30, incomingLearnedNotes: "" },
    { analysisKind: "initial_summary", itemCount: 30, incomingLearnedNotes: "画像阶段1" },
    { analysisKind: "initial_summary", itemCount: 10, incomingLearnedNotes: "画像阶段2" },
  ]);
  assert.equal(state.initialAnalysisCompleted, true);
  assert.equal(state.preferences.learnedNotes, "画像阶段3");
  assert.equal(state.items.every((item) => item.status === "processed"), true);

  // Reduce ran once at the end and published only 1 executive briefing card
  assert.equal(briefingInputs.length, 1);
  assert.equal(briefingInputs[0]?.totalScanned, 70);
  assert.equal(briefingInputs[0]?.silentCount, 67);
  assert.equal(briefingInputs[0]?.batchCount, 3);
  assert.equal(briefingInputs[0]?.candidates.length, 3);
  assert.equal(briefingInputs[0]?.preferences.learnedNotes, "画像阶段3");
  assert.equal(sentNotifications.length, 1);
  assert.equal(sentNotifications[0]?.text, "已梳理 70 条历史短信（过滤 67 条）：仅剩 3 条关键待办");
  assert.equal(lastRun.run.status, "completed");
  assert.equal(lastRun.run.publications[0]?.itemIds.length, 3);
  assert.equal(state.runs[0]?.publications.length, 0);
  assert.equal(state.runs[1]?.publications.length, 0);
  assert.equal(state.runs[2]?.publications.length, 1);

  // Next ingested SMS after initial drain runs as incremental
  await service.ingest([{ source: "sms", externalId: "live-1", content: "ACTIONABLE 新短信" }]);
  await service.runNow();
  assert.equal(rounds[3]?.analysisKind, "incremental");
  assert.equal(rounds[3]?.incomingLearnedNotes, "画像阶段3");
  assert.equal(briefingInputs.length, 1);
  assert.equal(sentNotifications.length, 2);
});

test("getStatus tracks queue counts and background + forceInitial runs drain asynchronously", async () => {
  let state: InformationState = {
    ...defaultInformationState(),
    settings: { enabled: true, batchWindowSeconds: 15, mode: "notifications" },
    initialAnalysisCompleted: true,
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
  const firstBatchGate = deferred<void>();
  let callIndex = 0;
  const capturedKinds: string[] = [];
  const notifications: Array<{ text: string; id: string }> = [];

  const service = createInformationService({
    repository,
    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-1",
        notify: async (text, id) => {
          notifications.push({ text, id });
          return { piSessionId: "session-1", messageId: id };
        },
      },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (input) => {
      callIndex++;
      capturedKinds.push(input.analysisKind);
      if (callIndex === 1) await firstBatchGate.promise;
      const notifyItems = input.items.filter((item) => item.content.includes("ACTIONABLE"));
      return {
        ok: true,
        result: {
          decisions: input.items.map((item) => ({
            itemId: item.id,
            decision: notifyItems.some((entry) => entry.id === item.id) ? "notify" as const : "silent" as const,
            reason: "evaluated",
          })),
          notifications: notifyItems.length
            ? [{ itemIds: notifyItems.map((item) => item.id), text: `摘要${callIndex}` }]
            : [],
          learnedNotes: `画像${callIndex}`,
        },
      };
    },
    enabledSkillTexts: async () => [],
  });

  await service.ingest(
    Array.from({ length: 40 }, (_value, index) => ({
      source: "sms",
      externalId: `bg-${index}`,
      content: index === 0 || index === 39 ? `ACTIONABLE ${index}` : `history ${index}`,
      receivedAt: new Date(Date.UTC(2026, 10, 1, Math.floor(index / 60), index % 60)).toISOString(),
    })),
  );
  const beforeRun = await service.getStatus();
  assert.deepEqual(beforeRun, {
    running: false,
    initialAnalysisCompleted: true,
    counts: { total: 40, pending: 40, processing: 0, processed: 0, failed: 0 },
  });

  const started = await service.runNow({ background: true, forceInitial: true });
  assert.equal(started.run.status, "running");
  assert.equal(started.run.kind, "initial_summary");
  assert.equal(started.run.itemIds.length, 30);

  const midStatus = await service.getStatus();
  assert.equal(midStatus.running, true);
  assert.equal(midStatus.initialAnalysisCompleted, false);
  assert.deepEqual(midStatus.counts, { total: 40, pending: 10, processing: 30, processed: 0, failed: 0 });
  await assert.rejects(service.runNow(), { code: "BUSY" });

  firstBatchGate.resolve();
  for (let i = 0; i < 50; i++) {
    const statusNow = await service.getStatus();
    if (!statusNow.running) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const doneStatus = await service.getStatus();
  assert.equal(doneStatus.running, false);
  assert.equal(doneStatus.initialAnalysisCompleted, true);
  assert.deepEqual(doneStatus.counts, { total: 40, pending: 0, processing: 0, processed: 40, failed: 0 });
  assert.ok(doneStatus.latestBriefing);
  assert.match(doneStatus.latestBriefing.text, /已梳理|历史短信/);
  assert.equal(doneStatus.lastError, undefined);
  assert.deepEqual(capturedKinds, ["initial_summary", "initial_summary"]);
  assert.equal(notifications.length, 1);
  assert.ok(notifications[0]!.text.length <= INITIAL_BRIEFING_MAX_LENGTH);
  assert.match(notifications[0]!.text, /已梳理|历史短信/);
});

test("parseInitialBriefingResult enforces 1200-char limit and valid candidate IDs", () => {
  const valid = parseInitialBriefingResult({ text: "  精炼简报  ", itemIds: ["a"] }, ["a", "b"]);
  assert.deepEqual(valid, { text: "精炼简报", itemIds: ["a"] });
  assert.deepEqual(parseInitialBriefingResult({ text: "无待办简报", itemIds: [] }, ["a"]), {
    text: "无待办简报",
    itemIds: [],
  });
  assert.throws(() => parseInitialBriefingResult({ text: "   ", itemIds: [] }, ["a"]), { code: "INVALID_INPUT" });
  assert.throws(
    () => parseInitialBriefingResult({ text: "x".repeat(INITIAL_BRIEFING_MAX_LENGTH + 1), itemIds: [] }, []),
    { code: "INVALID_INPUT" },
  );
  assert.throws(() => parseInitialBriefingResult({ text: "ok", itemIds: ["unknown"] }, ["a"]), { code: "INVALID_INPUT" });
  assert.throws(() => parseInitialBriefingResult({ text: "ok", itemIds: ["a", "a"] }, ["a"]), { code: "INVALID_INPUT" });
});

test("persisted Map-Reduce wave survives restart and passes cross-batch lifecycle updates to briefing synthesizer", async () => {
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
  // Pre-seed 35 items where batch 1 (30) already completed before a process restart
  const items = Array.from({ length: 35 }, (_v, idx) => ({
    id: `item-${idx}`,
    source: "sms",
    externalId: `ext-${idx}`,
    content: idx === 10
      ? "【京东快递】您的包裹 JD9901 已到达东门驿站，请及时取件"
      : idx === 32
        ? "【京东快递】您的包裹 JD9901 已于今日签收完成"
        : idx === 34
          ? "【招商银行】尾号8829信用卡本期应还 3200 元"
          : `促销垃圾 ${idx}`,
    receivedAt: new Date(Date.UTC(2026, 10, 1, Math.floor(idx / 60), idx % 60)).toISOString(),
    acceptedAt: new Date(Date.UTC(2026, 10, 1, Math.floor(idx / 60), idx % 60)).toISOString(),
    status: idx < 30 ? "processed" as const : "pending" as const,
    ...(idx < 30 ? { runId: "prior-run-1" } : {}),
  }));
  state = {
    ...state,
    initialAnalysisCompleted: false,
    preferences: { notes: "", learnedNotes: "批1画像：关注快递账单" },
    items,
    runs: [{
      id: "prior-run-1",
      kind: "initial_summary",
      itemIds: items.slice(0, 30).map((i) => i.id),
      status: "completed",
      createdAt: "2026-11-01T00:00:00.000Z",
      startedAt: "2026-11-01T00:00:00.000Z",
      finishedAt: "2026-11-01T00:00:05.000Z",
      model: { status: "succeeded" },
      decisions: items.slice(0, 30).map((item, idx) => ({
        itemId: item.id,
        decision: idx === 10 ? "notify" as const : "silent" as const,
        reason: idx === 10 ? "待取件" : "历史噪声",
      })),
      publications: [],
    }],
  };

  let capturedBriefing: InformationBriefingInput | undefined;
  const sent: Array<{ text: string; id: string }> = [];
  const restartedService = createInformationService({
    repository,
    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-1",
        notify: async (text, id) => {
          sent.push({ text, id });
          return { piSessionId: "session-1", messageId: id };
        },
      },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (input) => ({
      ok: true,
      result: {
        decisions: input.items.map((item) => ({
          itemId: item.id,
          decision: item.id === "item-34" ? "notify" as const : "silent" as const,
          reason: item.id === "item-32" ? "已签收完成" : "evaluated",
        })),
        notifications: input.items.some((i) => i.id === "item-34")
          ? [{ itemIds: ["item-34"], text: "招行账单待还" }]
          : [],
        learnedNotes: "批1+批2完整画像",
      },
    }),
    synthesizeBriefing: async (input) => {
      capturedBriefing = input;
      const kept = input.candidates.filter((c) => !input.relatedUpdates?.some((u) => u.content.includes("JD9901") && c.content.includes("JD9901")));
      return {
        ok: true,
        text: `已完成 ${input.totalScanned} 条短信梳理，当前待办：招行账单 3200 元（JD9901 已签收自动消除）。`,
        itemIds: kept.map((c) => c.itemId),
      };
    },
    enabledSkillTexts: async () => [],
  });

  await restartedService.runNow();
  assert.ok(capturedBriefing);
  assert.equal(capturedBriefing.batchCount, 2);
  assert.equal(capturedBriefing.totalScanned, 35);
  assert.equal(capturedBriefing.silentCount, 33);
  assert.equal(capturedBriefing.candidates.length, 2);
  assert.equal(capturedBriefing.relatedUpdates?.length, 1);
  assert.match(capturedBriefing.relatedUpdates?.[0]?.content ?? "", /JD9901 已于今日签收完成/);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /JD9901 已签收自动消除/);
  assert.equal(state.initialAnalysisCompleted, true);
});

test("reduce briefing failure falls back safely within 1200 chars, and silent bulk waves emit one summary card", async () => {
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
  const sent: string[] = [];
  const service = createInformationService({
    repository,
    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-1",
        notify: async (text, id) => {
          sent.push(text);
          return { piSessionId: "session-1", messageId: id };
        },
      },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (input) => {
      const notifyIds = input.items
        .filter((item, idx) => item.content.includes("NOTIFY") && idx < 10)
        .map((i) => i.id);
      return {
        ok: true,
        result: {
          decisions: input.items.map((item) => ({
            itemId: item.id,
            decision: notifyIds.includes(item.id) ? "notify" as const : "silent" as const,
            reason: "evaluated",
          })),
          notifications: notifyIds.length
            ? [{
                itemIds: notifyIds,
                text: "超长通知".repeat(300),
              }]
            : [],
          learnedNotes: "沉淀完成",
        },
      };
    },
    synthesizeBriefing: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    enabledSkillTexts: async () => [],
  });

  // 120 items where first 10 items per batch trigger verbose notifications, and Reduce fails
  await service.ingest(Array.from({ length: 120 }, (_v, idx) => ({
    source: "sms",
    externalId: `fallback-${idx}`,
    content: idx < 15 ? `NOTIFY 重要提醒 #${idx} ${"详情".repeat(80)}` : `广告 ${idx}`,
    receivedAt: new Date(Date.UTC(2026, 10, 1, Math.floor(idx / 60), idx % 60)).toISOString(),
  })), { bulkImport: true });
  await service.runNow();

  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.length <= INITIAL_BRIEFING_MAX_LENGTH);
  assert.match(sent[0]!, /已完成 120 条历史短信梳理/);
  assert.equal(state.initialAnalysisCompleted, true);
  assert.equal(state.preferences.learnedNotes, "沉淀完成");

  // Second bulk wave: 12 all-silent items still deliver 1 concise "暂无待办" card
  await service.ingest(Array.from({ length: 12 }, (_v, idx) => ({
    source: "sms",
    externalId: `silent-bulk-${idx}`,
    content: `促销短信 ${idx}`,
  })), { bulkImport: true });
  await service.runNow();
  assert.equal(sent.length, 2);
  assert.match(sent[1]!, /已完成 12 条历史短信全量梳理/);
});

test("bulkImport holds scheduler race during chunk uploads and preserves initialAnalysisCompleted on duplicate re-import", async () => {
  let state: InformationState = {
    ...defaultInformationState(),
    settings: { enabled: true, batchWindowSeconds: 0, mode: "notifications" },
    initialAnalysisCompleted: true,
    items: [{
      id: "old-1",
      source: "sms",
      externalId: "ext-old",
      content: "已有已处理短信",
      receivedAt: "2026-11-01T00:00:00.000Z",
      acceptedAt: "2026-11-01T00:00:00.000Z",
      status: "processed",
    }],
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
  const service = createInformationService({
    repository,
    retainMain: async () => ({
      conversation: { piSessionId: () => "session-1", notify: async (_t, id) => ({ piSessionId: "session-1", messageId: id }) },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (input) => ({
      ok: true,
      result: {
        decisions: input.items.map((item) => ({ itemId: item.id, decision: "silent" as const, reason: "ok" })),
        notifications: [],
      },
    }),
    enabledSkillTexts: async () => [],
  });

  // Duplicate bulkImport with 0 newly created items must NOT reset initialAnalysisCompleted
  await service.ingest([{ source: "sms", externalId: "ext-old", content: "已有已处理短信" }], { bulkImport: true });
  assert.equal(state.initialAnalysisCompleted, true);
  assert.equal(await service.nextDue(), false);
  assert.equal(await service.runDue(), false);

  // Genuine new bulkImport resets initialAnalysisCompleted and holds nextDue/runDue until runNow clears it
  await service.ingest([{ source: "sms", externalId: "ext-new", content: "新增历史短信" }], { bulkImport: true });
  assert.equal(state.initialAnalysisCompleted, false);
  assert.equal(await service.nextDue(), false);
  assert.equal(await service.runDue(), false);

  await service.runNow();
  assert.equal(state.initialAnalysisCompleted, true);
  assert.equal(state.runs[0]?.kind, "initial_summary");
});

test("all-silent bulk scan uses mapOnly + zero-itemId Reduce briefing, validates schema, and reports latestBriefing", async () => {
  let state: InformationState = {
    ...defaultInformationState(),
    settings: { enabled: true, batchWindowSeconds: 0, mode: "notifications" },
  };
  const repository: InformationRepository = {
    read: async () => structuredClone(state),
    update: async (change) => {
      const changed = await change(structuredClone(state));
      if (changed.state) state = parseInformationState(changed.state);
      return changed.result;
    },
    reconcileOnStart: async () => undefined,
    validateAll: async () => undefined,
  };
  const observedMapOnly: boolean[] = [];
  const sent: Array<{ text: string; id: string }> = [];
  const service = createInformationService({
    repository,
    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-silent",
        notify: async (text, id) => {
          sent.push({ text, id });
          return { piSessionId: "session-silent", messageId: `msg-${id}` };
        },
      },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (input) => {
      observedMapOnly.push(Boolean(input.mapOnly));
      return {
        ok: true,
        result: {
          decisions: input.items.map((item) => ({ itemId: item.id, decision: "silent" as const, reason: "促销营销" })),
          notifications: [],
          learnedNotes: "仅识别营销推广，暂无待办",
        },
      };
    },
    synthesizeBriefing: async (input) => ({
      ok: true,
      text: `扫描 ${input.totalScanned} 条历史短信，均已归类为静默，当前无待办事项。`,
      itemIds: [],
    }),
    enabledSkillTexts: async () => [],
  });

  await service.ingest(
    Array.from({ length: 12 }, (_v, idx) => ({ source: "sms", externalId: `all-silent-${idx}`, content: `营销推送 ${idx}` })),
    { bulkImport: true },
  );
  await service.runNow({ forceInitial: true });

  assert.deepEqual(observedMapOnly, [true]);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /扫描 12 条历史短信/);
  const status = await service.getStatus();
  assert.equal(status.initialAnalysisCompleted, true);
  assert.equal(status.lastError, undefined);
  assert.ok(status.latestBriefing);
  assert.equal(status.latestBriefing.itemCount, 0);
  assert.equal(status.latestBriefing.messageId, `msg-${status.latestBriefing.notificationId}`);
  assert.match(status.latestBriefing.text, /扫描 12 条历史短信/);
});

test("retryFailed resets failed batches, clears lastError, and completes initial briefing on retry", async () => {
  let state: InformationState = {
    ...defaultInformationState(),
    settings: { enabled: true, batchWindowSeconds: 0, mode: "notifications" },
  };
  const repository: InformationRepository = {
    read: async () => structuredClone(state),
    update: async (change) => {
      const changed = await change(structuredClone(state));
      if (changed.state) state = parseInformationState(changed.state);
      return changed.result;
    },
    reconcileOnStart: async () => undefined,
    validateAll: async () => undefined,
  };
  let failBatch2 = true;
  let round = 0;
  const sent: string[] = [];
  const service = createInformationService({
    repository,
    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-retry",
        notify: async (text, id) => {
          sent.push(text);
          return { piSessionId: "session-retry", messageId: `msg-${id}` };
        },
      },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (input) => {
      round++;
      if (failBatch2 && round === 2) {
        return { ok: false, error: "INVALID_MODEL_RESULT" };
      }
      const notifyIds = input.items.filter((item) => item.content.includes("PICKUP")).map((item) => item.id);
      return {
        ok: true,
        result: {
          decisions: input.items.map((item) => ({
            itemId: item.id,
            decision: notifyIds.includes(item.id) ? "notify" as const : "silent" as const,
            reason: "评估完成",
          })),
          notifications: [],
          learnedNotes: `累计画像-${round}`,
        },
      };
    },
    synthesizeBriefing: async (input) => ({
      ok: true,
      text: `已完成 ${input.totalScanned} 条短信梳理，提取 ${input.candidates.length} 条待取提醒。`,
      itemIds: input.candidates.map((c) => c.itemId),
    }),
    enabledSkillTexts: async () => [],
  });

  await service.ingest(
    Array.from({ length: 35 }, (_v, idx) => ({
      source: "sms",
      externalId: `retry-${idx}`,
      content: idx === 32 ? "PICKUP 取件码 8-1-203" : `历史营销 ${idx}`,
      receivedAt: new Date(Date.UTC(2026, 10, 1, Math.floor(idx / 60), idx % 60)).toISOString(),
    })),
    { bulkImport: true },
  );
  await service.runNow({ forceInitial: true });

  const failedStatus = await service.getStatus();
  assert.equal(failedStatus.initialAnalysisCompleted, false);
  assert.deepEqual(failedStatus.counts, { total: 35, pending: 0, processing: 0, processed: 30, failed: 5 });
  assert.equal(failedStatus.lastError, "INVALID_MODEL_RESULT");
  assert.equal(failedStatus.latestBriefing, undefined);
  assert.equal(sent.length, 0);

  failBatch2 = false;
  await service.runNow({ background: true, forceInitial: true, retryFailed: true });
  for (let i = 0; i < 50; i++) {
    const s = await service.getStatus();
    if (!s.running) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const recovered = await service.getStatus();
  assert.equal(recovered.initialAnalysisCompleted, true);
  assert.deepEqual(recovered.counts, { total: 35, pending: 0, processing: 0, processed: 35, failed: 0 });
  assert.equal(recovered.lastError, undefined);
  assert.ok(recovered.latestBriefing);
  assert.equal(recovered.latestBriefing.itemCount, 1);
  assert.match(recovered.latestBriefing.text, /已完成 35 条短信梳理/);
  assert.equal(sent.length, 1);
});

test("mapOnly submit_information_result omits notifications schema property and rejects unexpected fields", async () => {
  const submissions: unknown[] = [];
  const tool = createSubmitInformationResultTool(
    ["item-1"],
    (value) => { submissions.push(value); },
    "notifications",
    { omitNotifications: true },
  );
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["decisions", "learnedNotes"]);
  assert.equal("notifications" in tool.parameters.properties, false);
  const invoke = (input: unknown) => tool.execute("map", input as never, undefined, undefined, {} as never);

  const okSilent = await invoke({ decisions: [{ itemId: "item-1", decision: "silent", reason: "营销" }], learnedNotes: "画像" });
  assert.equal(okSilent.isError, undefined);
  const okNotifyWithoutNotifications = await invoke({ decisions: [{ itemId: "item-1", decision: "notify", reason: "待取" }] });
  assert.equal(okNotifyWithoutNotifications.isError, undefined);
  const rejectedObj = await invoke({ decisions: [{ itemId: "item-1", decision: "silent", reason: "营销" }], notifications: {} });
  assert.equal(rejectedObj.isError, true);
  assert.equal(submissions.length, 2);
});
