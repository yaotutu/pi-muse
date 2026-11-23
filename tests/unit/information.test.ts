import { memoryInformationRules } from "../support/information-rules.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSubmitInformationBriefingTool,
  createSubmitInformationResultTool,
} from "../../src/adapters/pi/information-runner.js";
import { createInformationService } from "../../src/features/information/service.js";
import {
  defaultInformationState,
  type InformationBriefingInput,
  type InformationPublicationReceipt,
  type InformationRepository,
  type InformationState,
} from "../../src/features/information/types.js";
import {
  ARCHIVE_BRIEFING_MAX_LENGTH,
  parseInformationBriefingResult,
  parseInformationResult,
} from "../../src/features/information/result.js";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const emptyFeedback = () => ({ schemaVersion: 1 as const, events: [] });

const memoryRepo = (initial: InformationState = defaultInformationState()) => {
  let state = structuredClone(initial);
  const repository: InformationRepository = {
    read: async () => structuredClone(state),
    update: async (change) => {
      const changed = await change(structuredClone(state));
      if (changed.state) state = changed.state;
      return changed.result;
    },
    validateAll: async () => undefined,
    nextRealtimeDue: async () => {
      if (!state.settings.enabled) return false;
      const first = state.items.find((item) => item.queue === "realtime" && item.status === "pending");
      if (!first) return false;
      return Date.now() >= Date.parse(first.acceptedAt) + state.settings.batchWindowSeconds * 1000;
    },
    reconcileOnStart: async () => undefined,
  };
  return { repository, readState: () => structuredClone(state) };
};

const fixture = (options?: {
  notify?: (text: string, id: string) => Promise<InformationPublicationReceipt>;
  feedbackRead?: () => Promise<{ schemaVersion: 1; events: never[] }>;
  initial?: InformationState;
}) => {
  const { repository, readState } = memoryRepo(options?.initial);
  const notifications: Array<{ text: string; id: string }> = [];
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-1",
        notify: async (text, id) => {
          notifications.push({ text, id });
          return options?.notify?.(text, id) ?? { notificationId: id, piSessionId: "session-1", messageId: id };
        },
      },
      release: () => undefined,
    }),
    feedback: { read: options?.feedbackRead ?? (async () => emptyFeedback()) } as never,
    runModel: async () => { throw new Error("unexpected model call"); },
  });
  return { repository, service, notifications, readState };
};

const resultFor = (itemIds: string[], notifyCount = 1) => ({
  decisions: itemIds.map((id, index) => ({
    itemId: id,
    decision: index < notifyCount ? "notify" as const : "silent" as const,
    reason: "test reason",
  })),
  notifications: notifyCount ? [{ itemIds: itemIds.slice(0, notifyCount), text: "NOTIFY" }] : [],
});

test("information result validator enforces exact coverage, bounds and archive batch requirements", () => {
  const good = parseInformationResult(resultFor(["a", "b"]), ["a", "b"], { allowNotifications: true });
  assert.equal(good.decisions.length, 2);

  assert.throws(() => parseInformationResult({ decisions: [], notifications: [] }, ["a"], { allowNotifications: true }));
  assert.throws(() => parseInformationResult({
    decisions: [{ itemId: "a", decision: "notify", reason: "x" }],
    notifications: [{ itemIds: ["a"], text: "x".repeat(4001) }],
  }, ["a"], { allowNotifications: true }));
  assert.throws(() => parseInformationResult({
    decisions: [{ itemId: "a", decision: "notify", reason: "x" }],
    notifications: [],
  }, ["a"], { allowNotifications: true }));
  assert.throws(() => parseInformationResult({
    decisions: [
      { itemId: "a", decision: "notify", reason: "x" },
      { itemId: "a", decision: "silent", reason: "x" },
    ],
    notifications: [{ itemIds: ["a"], text: "ok" }],
  }, ["a", "a"], { allowNotifications: true }));

  // Archive batch forbids notifications field and requires learnedNotes
  const archive = parseInformationResult({
    decisions: [
      { itemId: "a", decision: "notify", reason: "pending parcel" },
      { itemId: "b", decision: "silent", reason: "promo" },
    ],
    learnedNotes: "关注快递，忽略促销",
  }, ["a", "b"], { allowNotifications: false, requireLearnedNotes: true });
  assert.deepEqual(archive.notifications, []);
  assert.equal(archive.learnedNotes, "关注快递，忽略促销");

  assert.throws(() => parseInformationResult({
    decisions: [{ itemId: "a", decision: "notify", reason: "x" }],
    notifications: [{ itemIds: ["a"], text: "chat" }],
    learnedNotes: "",
  }, ["a"], { allowNotifications: false, requireLearnedNotes: true }));
  assert.throws(() => parseInformationResult({
    decisions: [{ itemId: "a", decision: "notify", reason: "x" }],
    notifications: [],
    learnedNotes: "",
  }, ["a"], { allowNotifications: false, requireLearnedNotes: true }));
  const revalidatedArchive = parseInformationResult(archive, ["a", "b"], {
    allowNotifications: false,
    allowEmptyNotifications: true,
    requireLearnedNotes: true,
  });
  assert.deepEqual(revalidatedArchive, archive);
  assert.throws(() => parseInformationResult({
    decisions: [{ itemId: "a", decision: "notify", reason: "x" }],
    notifications: [{ itemIds: ["a"], text: "chat" }],
    learnedNotes: "",
  }, ["a"], { allowNotifications: false, allowEmptyNotifications: true, requireLearnedNotes: true }));
  assert.throws(() => parseInformationResult({
    decisions: [{ itemId: "a", decision: "silent", reason: "x" }],
  }, ["a"], { allowNotifications: false, requireLearnedNotes: true }));
});

test("manual and automatic realtime runs contend on one synchronously reserved global slot", async () => {
  const model = deferred<ReturnType<typeof resultFor>>();
  let capturedIds: string[] = [];
  const base = fixture();
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository: base.repository,
    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-1",
        notify: async (_text, id) => ({ notificationId: id, piSessionId: "session-1", messageId: id }),
      },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (value) => {
      capturedIds = value.items.map((item) => item.id);
      const result = await model.promise;
      return { ok: true, result };
    },
  });
  await service.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await service.ingest([
    { source: "sms", externalId: "1", content: "NOTIFY one" },
    { source: "sms", externalId: "2", content: "silent two" },
  ]);
  const first = service.runNow();
  await assert.rejects(service.runNow(), { code: "BUSY" });
  assert.equal(await service.runDue(), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capturedIds.length, 2);
  model.resolve(resultFor(capturedIds));
  const finished = await first;
  assert.equal(finished.run.kind, "realtime");
  assert.equal(finished.run.status, "completed");
  assert.equal(finished.run.itemIds.length, 2);
  assert.equal((await service.listRuns({})).runs.length, 1);
  assert.equal(finished.run.publications[0]?.status, "published");
});

test("processing setup failures mark the run failed and release the global slot", async () => {
  let modelCalled = false;
  const base = fixture();
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository: base.repository,
    retainMain: async () => { throw new Error("retain I/O failed"); },
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async () => { modelCalled = true; return { ok: false, error: "MODEL_REQUEST_FAILED" }; },
  });
  await service.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await service.ingest([{ source: "sms", externalId: "1", content: "one" }]);
  await assert.rejects(service.runNow(), /retain I\/O failed/);
  const state = base.readState();
  assert.equal(state.runs[0]?.status, "failed");
  assert.equal(state.items[0]?.status, "failed");
  assert.equal(modelCalled, false);
  assert.equal(await service.runDue(), false, "global slot must be released");
});

test("cancellation while retain is pending releases main and reverts items to pending", async () => {
  const base = fixture();
  const retainGate = deferred<void>();
  let retainStarted = false;
  let retainReleased = false;
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository: base.repository,
    retainMain: async () => {
      retainStarted = true;
      await retainGate.promise;
      return {
        conversation: { piSessionId: () => "session-1", notify: async (_text, id) => ({ notificationId: id, piSessionId: "session-1", messageId: id }) },
        release: () => { retainReleased = true; },
      };
    },
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
  });
  await service.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await service.ingest([{ source: "sms", externalId: "1", content: "one" }]);
  const running = service.runNow();
  while (!retainStarted) await new Promise((resolve) => setImmediate(resolve));
  const pause = service.pause();
  retainGate.resolve();
  const detail = await running;
  await pause.stopped;
  assert.equal(detail.run.status, "cancelled");
  assert.equal(base.readState().items[0]?.status, "pending");
  assert.equal(base.readState().items[0]?.runId, undefined);
  assert.equal(retainReleased, true);
  pause.resume();
});

test("cancellation after a successful model result preserves model success and marks delivery failed", async () => {
  const base = fixture();
  const modelGate = deferred<void>();
  let itemId: string | undefined;
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository: base.repository,
    retainMain: async () => ({
      conversation: { piSessionId: () => "session-1", notify: async (_text, id) => ({ notificationId: id, piSessionId: "session-1", messageId: id }) },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (input) => {
      itemId = input.items[0]?.id;
      await modelGate.promise;
      return { ok: true, result: resultFor([itemId!]) };
    },
  });
  await service.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await service.ingest([{ source: "sms", externalId: "1", content: "urgent" }]);
  const running = service.runNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(itemId);
  const pause = service.pause();
  modelGate.resolve();
  await pause.stopped;
  const detail = await running;
  pause.resume();
  assert.equal(detail.run.status, "completed");
  assert.equal(detail.run.model?.status, "succeeded");
  assert.equal(detail.run.publications[0]?.status, "failed");
  assert.match(detail.run.publications[0]?.error ?? "", /Cancelled before notification delivery/);
  assert.equal(base.readState().items[0]?.status, "processed");
});

test("pause barrier is nested and aborts active model rounds cleanly", async () => {
  const base = fixture();
  const gate = deferred<void>();
  let started = false;
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository: base.repository,
    retainMain: async () => ({
      conversation: { piSessionId: () => "session-1", notify: async (_text, id) => ({ notificationId: id, piSessionId: "session-1", messageId: id }) },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (_input, signal) => {
      started = true;
      signal.addEventListener("abort", () => gate.resolve(), { once: true });
      await gate.promise;
      return { ok: false, error: "CANCELLED" };
    },
  });
  await service.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await service.ingest([{ source: "sms", externalId: "1", content: "urgent" }]);

  const first = service.pause();
  const second = service.pause();
  await assert.rejects(service.runNow(), { code: "SESSION_PAUSED" });
  assert.equal(await service.runDue(), false);
  assert.equal(await service.nextDue(), false);
  first.resume();
  await assert.rejects(service.runNow(), { code: "SESSION_PAUSED" });
  second.resume();
  assert.equal(await service.nextDue(), true);

  const running = service.runNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  const activePause = service.pause();
  await activePause.stopped;
  const detail = await running;
  assert.equal(detail.run.status, "cancelled");
  assert.equal(base.readState().items[0]?.status, "pending");
  assert.equal(base.readState().items[0]?.runId, undefined);
  activePause.resume();
});

test("pagination binds cursor to queue and status filters and omits nextCursor on final page", async () => {
  const at = new Date().toISOString();
  const items: InformationState["items"] = [0, 1, 2, 3, 4].map((index) => ({
    id: `item-${index}`,
    queue: index === 4 ? "archive" : "realtime",
    source: "sms",
    externalId: String(index),
    content: `content-${index}`,
    receivedAt: at,
    acceptedAt: at,
    status: index === 3 ? "processed" : "pending",
  }));
  const { repository } = memoryRepo({ ...defaultInformationState(), items });
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => undefined,
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
  });

  const p1 = await service.listItems({ limit: 2 });
  const p2 = await service.listItems({ limit: 2, cursor: p1.nextCursor });
  const p3 = await service.listItems({ limit: 2, cursor: p2.nextCursor });
  assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map((item) => item.id), ["item-4", "item-3", "item-2", "item-1", "item-0"]);
  assert.equal(p3.nextCursor, undefined);

  const pendingRt = await service.listItems({ queue: "realtime", status: "pending", limit: 1 });
  const pendingRtNext = await service.listItems({ queue: "realtime", status: "pending", limit: 1, cursor: pendingRt.nextCursor });
  assert.deepEqual([pendingRt.items[0]?.id, pendingRtNext.items[0]?.id], ["item-2", "item-1"]);
  await assert.rejects(
    service.listItems({ queue: "archive", status: "pending", limit: 1, cursor: pendingRt.nextCursor }),
    { code: "INVALID_INPUT" },
  );
});

test("feedback examples expose current projections and storage failures loudly", async () => {
  const at = new Date().toISOString();
  const initial: InformationState = {
    ...defaultInformationState(),
    items: [{
      id: "item-1", queue: "realtime", source: "sms", externalId: "x",
      title: "Original title", content: "A".repeat(2500), receivedAt: at, acceptedAt: at, status: "processed",
    }],
    runs: [{
      id: "run-1", kind: "realtime", itemIds: ["item-1"], status: "completed",
      createdAt: at, startedAt: at,
      publications: [{
        notificationId: "notification-1", itemIds: ["item-1"], text: "summary",
        status: "published", receipt: { notificationId: "notification-1", piSessionId: "session-1", messageId: "notification-1" },
      }],
    }],
  };
  const { repository } = memoryRepo(initial);
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => ({
      conversation: { piSessionId: () => "session-1", notify: async (_text, id) => ({ notificationId: id, piSessionId: "session-1", messageId: id }) },
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
  });
  const preferences = await service.getPreferences();
  assert.equal(preferences.feedbackExamples.length, 1);
  assert.equal(preferences.feedbackExamples[0]?.reaction, "like");
  assert.deepEqual(preferences.feedbackExamples[0]?.comments, ["latest"]);
  assert.equal(preferences.feedbackExamples[0]?.items[0]?.content.length, 2000);
  assert.equal(preferences.feedbackExamples[0]?.items[0]?.contentTruncated, true);

  const failingService = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => ({
      conversation: { piSessionId: () => "session-1", notify: async (_text, id) => ({ notificationId: id, piSessionId: "session-1", messageId: id }) },
      release: () => undefined,
    }),
    feedback: { read: async () => { throw new Error("corrupt feedback"); } } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
  });
  await assert.rejects(failingService.getPreferences(), /corrupt feedback/);
});

test("realtime runs persist and evolve learnedNotes while archive channel stays isolated until explicit runArchive", async () => {
  const { repository, readState } = memoryRepo({
    ...defaultInformationState(),
    settings: { enabled: true, batchWindowSeconds: 0 },
  });
  const captured: Array<{ kind: string; count: number; learnedNotes: string }> = [];
  const briefingInputs: InformationBriefingInput[] = [];
  const sentNotifications: Array<{ text: string; id: string }> = [];

  const service = createInformationService({
    instructions: memoryInformationRules("优先提醒银行与快递"),
    repository,
    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-1",
        notify: async (text, id) => {
          sentNotifications.push({ text, id });
          return { notificationId: id, piSessionId: "session-1", messageId: id };
        },
      },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (input) => {
      captured.push({ kind: input.kind, count: input.items.length, learnedNotes: input.learnedNotes });
      const notifyIds = input.items.filter((item) => item.content.includes("ACTIONABLE")).map((item) => item.id);
      return {
        ok: true,
        result: {
          decisions: input.items.map((item) => ({
            itemId: item.id,
            decision: notifyIds.includes(item.id) ? "notify" as const : "silent" as const,
            reason: "evaluated",
          })),
          notifications: input.kind === "realtime" && notifyIds.length
            ? [{ itemIds: notifyIds, text: `实时通知(${notifyIds.length})` }]
            : [],
          learnedNotes: `画像-${captured.length}`,
        },
      };
    },
    synthesizeBriefing: async (input) => {
      briefingInputs.push(input);
      return {
        ok: true,
        text: `已梳理 ${input.totalScanned} 条历史短信（过滤 ${input.silentCount} 条）：仅剩 ${input.candidates.length} 条待办`,
        itemIds: input.candidates.map((c) => c.itemId),
      };
    },
  });

  // 1. 导入 60 条历史短信到 archive（25 + 25 + 10）；不得唤醒 realtime 调度！
  const archiveInputs = Array.from({ length: 60 }, (_v, idx) => ({
    source: "sms",
    externalId: `hist-${idx}`,
    content: (idx === 0 || idx === 25 || idx === 59) ? `ACTIONABLE 历史 ${idx}` : `广告 ${idx}`,
  }));
  const archRes = await service.ingestArchive(archiveInputs);
  assert.equal(archRes.items.length, 60);
  assert.equal(await service.nextDue(), false, "archive items must never wake realtime scheduler");
  assert.equal(await service.runDue(), false);

  // 2. 显式触发 runArchive：3 个 archive 批逐步演化 learnedNotes，最终发 1 条 <= 1200 字简报
  const summary = await service.runArchive();
  assert.deepEqual(summary, {
    status: "completed",
    runsCount: 3,
    processedCount: 60,
    failedCount: 0,
    remainingPendingCount: 0,
    briefingPublished: true,
  });
  assert.deepEqual(captured, [
    { kind: "archive", count: 25, learnedNotes: "" },
    { kind: "archive", count: 25, learnedNotes: "画像-1" },
    { kind: "archive", count: 10, learnedNotes: "画像-2" },
  ]);
  assert.equal(readState().preferences.learnedNotes, "画像-3");
  assert.equal(briefingInputs.length, 1);
  assert.equal(briefingInputs[0]?.totalScanned, 60);
  assert.equal(briefingInputs[0]?.candidates.length, 3);
  assert.equal(sentNotifications.length, 1);
  assert.ok(sentNotifications[0]!.text.length <= ARCHIVE_BRIEFING_MAX_LENGTH);

  // 3. 随后的日常实时短信继承归档沉淀的 learnedNotes，走单周期直接推送
  await service.ingest([{ source: "sms", externalId: "rt-1", content: "ACTIONABLE 新取件码 9527" }]);
  assert.equal(await service.nextDue(), true);
  assert.equal(await service.runDue(), true);
  assert.equal(captured[3]?.kind, "realtime");
  assert.equal(captured[3]?.learnedNotes, "画像-3");
  assert.equal(sentNotifications.length, 2);
  assert.equal((await service.getPreferences()).learnedNotes, "画像-4");
});

test("archive failure stops briefing until retryFailed drains remaining items cleanly", async () => {
  const { repository } = memoryRepo(defaultInformationState());
  const sent: string[] = [];
  let failBatch2 = true;
  let round = 0;

  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-retry",
        notify: async (text, id) => {
          sent.push(text);
          return { notificationId: id, piSessionId: "session-retry", messageId: `msg-${id}` };
        },
      },
      release: () => undefined,
    }),
    feedback: { read: async () => emptyFeedback() } as never,
    runModel: async (input) => {
      round++;
      if (failBatch2 && round === 2) return { ok: false, error: "INVALID_MODEL_RESULT" };
      const notifyIds = input.items.filter((item) => item.content.includes("PICKUP")).map((item) => item.id);
      return {
        ok: true,
        result: {
          decisions: input.items.map((item) => ({
            itemId: item.id,
            decision: notifyIds.includes(item.id) ? "notify" as const : "silent" as const,
            reason: "ok",
          })),
          notifications: [],
          learnedNotes: `累计画像-${round}`,
        },
      };
    },
    synthesizeBriefing: async (input) => ({
      ok: true,
      text: `已完成 ${input.totalScanned} 条归档梳理，提取 ${input.candidates.length} 条待取提醒。`,
      itemIds: input.candidates.map((c) => c.itemId),
    }),
  });

  await service.ingestArchive(
    Array.from({ length: 30 }, (_v, idx) => ({
      source: "sms",
      externalId: `retry-${idx}`,
      content: idx === 28 ? "PICKUP 取件码 8-1-203" : `广告 ${idx}`,
    })),
  );
  const partial = await service.runArchive();
  assert.equal(partial.status, "partial");
  assert.equal(partial.processedCount, 25);
  assert.equal(partial.failedCount, 5);
  assert.equal(partial.briefingPublished, false);
  assert.equal(sent.length, 0);

  const midStatus = await service.getStatus();
  assert.deepEqual(midStatus.archive, { running: false, pendingCount: 0, processedCount: 25, failedCount: 5 });

  failBatch2 = false;
  await service.runArchive({ background: true, retryFailed: true });
  for (let i = 0; i < 50; i++) {
    if (!(await service.getStatus()).running) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const done = await service.getStatus();
  assert.deepEqual(done.archive, { running: false, pendingCount: 0, processedCount: 30, failedCount: 0 });
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /已完成 30 条归档梳理/);
});

test("parseInformationBriefingResult and archive tool schemas enforce strict bounds", async () => {
  assert.deepEqual(parseInformationBriefingResult({ text: "  精炼简报  ", itemIds: ["a"] }, ["a", "b"]), {
    text: "精炼简报",
    itemIds: ["a"],
  });
  assert.deepEqual(parseInformationBriefingResult({ text: "无待办简报", itemIds: [] }, ["a"]), {
    text: "无待办简报",
    itemIds: [],
  });
  assert.throws(() => parseInformationBriefingResult({ text: "   ", itemIds: [] }, ["a"]), { code: "INVALID_INPUT" });
  assert.throws(
    () => parseInformationBriefingResult({ text: "x".repeat(ARCHIVE_BRIEFING_MAX_LENGTH + 1), itemIds: [] }, []),
    { code: "INVALID_INPUT" },
  );
  assert.throws(() => parseInformationBriefingResult({ text: "ok", itemIds: ["unknown"] }, ["a"]), { code: "INVALID_INPUT" });

  const submissions: unknown[] = [];
  const archiveTool = createSubmitInformationResultTool(
    ["item-1"],
    (value) => { submissions.push(value); },
    { allowNotifications: false, requireLearnedNotes: true },
  );
  assert.deepEqual(Object.keys(archiveTool.parameters.properties).sort(), ["decisions", "learnedNotes"]);
  const okArchive = await archiveTool.execute("arch", {
    decisions: [{ itemId: "item-1", decision: "silent", reason: "营销" }],
    learnedNotes: "画像",
  } as never, undefined, undefined, {} as never);
  assert.equal(okArchive.isError, undefined);
  const badArchive = await archiveTool.execute("arch-bad", {
    decisions: [{ itemId: "item-1", decision: "silent", reason: "营销" }],
    notifications: {},
  } as never, undefined, undefined, {} as never);
  assert.equal(badArchive.isError, true);
  assert.equal(submissions.length, 1);

  const briefingTool = createSubmitInformationBriefingTool(["c1"], () => undefined);
  const okBriefing = await briefingTool.execute("b", { text: "归档完毕", itemIds: [] } as never, undefined, undefined, {} as never);
  assert.equal(okBriefing.isError, undefined);
});
