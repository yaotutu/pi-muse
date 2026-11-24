import { memoryInformationRules } from "../support/information-rules.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  createSubmitInformationBriefingTool,
  createSubmitInformationResultTool,
} from "../../src/adapters/pi/information-runner.js";
import { createInformationRepository } from "../../src/adapters/storage/information-repository.js";
import {
  canonicalJson,
  ensureSmsModule,
  parsePublicationsJson,
  readSmsSettingsSync,
  smsModule,
  writeSmsSettingsSync,
} from "../../src/adapters/storage/sms-schema.js";
import type { ManagedSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import type { HabitItem, HabitOperation } from "../../src/features/habits/types.js";
import { createInformationService } from "../../src/features/information/service.js";
import type {
  InformationBriefingInput,
  InformationItem,
  InformationPublicationReceipt,
  InformationRun,
  InformationSettings,
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

type SeedInformationState = {
  settings?: InformationSettings;
  items?: InformationItem[];
  runs?: InformationRun[];
};

const memoryRepo = (initial: SeedInformationState = {}) => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  let pending: Promise<unknown> = Promise.resolve();
  const managed: ManagedSqliteDatabase = {
    database,
    serialize: <T>(work: () => T | Promise<T>) => {
      const next = pending.then(work, work);
      pending = next.then(() => undefined, () => undefined);
      return next;
    },
    transaction: <T>(work: () => T) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close: async () => { database.close(); },
  };
  ensureSqliteModules(managed, [smsModule]);
  ensureSmsModule(managed);
  if (initial.settings) {
    writeSmsSettingsSync(database, initial.settings);
  }
  if (initial.items?.length) {
    const insertItem = database.prepare(
      "INSERT INTO sms_items (id, position, queue, source, external_id, title, content, received_at, accepted_at, status, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    initial.items.forEach((item, index) => {
      insertItem.run(
        item.id,
        index + 1,
        item.queue,
        item.source,
        item.externalId,
        item.title ?? null,
        item.content,
        item.receivedAt,
        item.acceptedAt,
        item.status,
        item.runId ?? null,
      );
    });
  }
  if (initial.runs?.length) {
    const insertRun = database.prepare(
      "INSERT INTO sms_runs (id, position, kind, status, created_at, started_at, finished_at, model_status, model_error, has_decisions, publications_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertRunItem = database.prepare("INSERT INTO sms_run_items (run_id, position, item_id) VALUES (?, ?, ?)");
    const insertDecision = database.prepare("INSERT INTO sms_decisions (run_id, position, item_id, decision, reason) VALUES (?, ?, ?, ?, ?)");
    initial.runs.forEach((run, index) => {
      insertRun.run(
        run.id,
        index + 1,
        run.kind,
        run.status,
        run.createdAt,
        run.startedAt,
        run.finishedAt ?? null,
        run.model?.status ?? null,
        run.model?.error ?? null,
        run.decisions !== undefined ? 1 : 0,
        canonicalJson(run.publications ?? []),
      );
      run.itemIds.forEach((itemId, pos) => insertRunItem.run(run.id, pos, itemId));
      run.decisions?.forEach((d, pos) => insertDecision.run(run.id, pos, d.itemId, d.decision, d.reason));
    });
  }
  const readState = () => {
    const settings = readSmsSettingsSync(database);
    const itemRows = database.prepare(
      "SELECT id, queue, source, external_id, title, content, received_at, accepted_at, status, run_id FROM sms_items ORDER BY position ASC",
    ).all() as Array<{
      id: string; queue: "realtime" | "archive"; source: string; external_id: string;
      title: string | null; content: string; received_at: string; accepted_at: string;
      status: "pending" | "processing" | "processed" | "failed"; run_id: string | null;
    }>;
    const items: InformationItem[] = itemRows.map((row) => ({
      id: row.id,
      queue: row.queue,
      source: row.source,
      externalId: row.external_id,
      ...(row.title !== null ? { title: row.title } : {}),
      content: row.content,
      receivedAt: row.received_at,
      acceptedAt: row.accepted_at,
      status: row.status,
      ...(row.run_id !== null ? { runId: row.run_id } : {}),
    }));
    const runRows = database.prepare(
      "SELECT id, kind, status, created_at, started_at, finished_at, model_status, model_error, has_decisions, publications_json FROM sms_runs ORDER BY position ASC",
    ).all() as Array<{
      id: string; kind: "realtime" | "archive"; status: "running" | "completed" | "failed" | "cancelled";
      created_at: string; started_at: string; finished_at: string | null;
      model_status: "succeeded" | "failed" | null; model_error: string | null;
      has_decisions: number; publications_json: string;
    }>;
    const runs: InformationRun[] = runRows.map((row) => {
      const itemIds = (database.prepare("SELECT item_id FROM sms_run_items WHERE run_id = ? ORDER BY position ASC").all(row.id) as Array<{ item_id: string }>).map((r) => r.item_id);
      const decisionRows = database.prepare("SELECT item_id, decision, reason FROM sms_decisions WHERE run_id = ? ORDER BY position ASC").all(row.id) as Array<{ item_id: string; decision: "silent" | "notify"; reason: string }>;
      return {
        id: row.id,
        kind: row.kind,
        itemIds,
        status: row.status,
        createdAt: row.created_at,
        startedAt: row.started_at,
        ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
        ...(row.model_status !== null ? { model: { status: row.model_status, ...(row.model_error !== null ? { error: row.model_error } : {}) } } : {}),
        ...(row.has_decisions === 1 ? { decisions: decisionRows.map((d) => ({ itemId: d.item_id, decision: d.decision, reason: d.reason })) } : {}),
        publications: parsePublicationsJson(row.publications_json),
      };
    });
    return { settings, items, runs };
  };
  return { repository: createInformationRepository(managed), readState };
};

const fixture = (options?: {
  notify?: (text: string, id: string) => Promise<InformationPublicationReceipt>;
  initial?: SeedInformationState;
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

  // Archive batch forbids notifications field and optionally accepts habitOperations
  const archive = parseInformationResult({
    decisions: [
      { itemId: "a", decision: "notify", reason: "pending parcel" },
      { itemId: "b", decision: "silent", reason: "promo" },
    ],
    habitOperations: [{ op: "add", text: "关注快递，忽略促销" }],
  }, ["a", "b"], { allowNotifications: false, allowHabitOperations: true });
  assert.deepEqual(archive.notifications, []);
  assert.deepEqual(archive.habitOperations, [{ op: "add", text: "关注快递，忽略促销" }]);

  assert.throws(() => parseInformationResult({
    decisions: [{ itemId: "a", decision: "notify", reason: "x" }],
    notifications: [{ itemIds: ["a"], text: "chat" }],
  }, ["a"], { allowNotifications: false, allowHabitOperations: true }));
  assert.throws(() => parseInformationResult({
    decisions: [{ itemId: "a", decision: "notify", reason: "x" }],
    notifications: [],
    learnedNotes: "",
  }, ["a"], { allowNotifications: false, allowHabitOperations: true }));
  const revalidatedArchive = parseInformationResult(archive, ["a", "b"], {
    allowNotifications: false,
    allowEmptyNotifications: true,
    allowHabitOperations: true,
  });
  assert.deepEqual(revalidatedArchive, archive);
  assert.throws(() => parseInformationResult({
    decisions: [{ itemId: "a", decision: "notify", reason: "x" }],
    notifications: [{ itemIds: ["a"], text: "chat" }],
  }, ["a"], { allowNotifications: false, allowEmptyNotifications: true, allowHabitOperations: true }));

  // Archive allows omitting habitOperations when no new rules were found
  const emptyOps = parseInformationResult({
    decisions: [{ itemId: "a", decision: "silent", reason: "x" }],
  }, ["a"], { allowNotifications: false, allowHabitOperations: true });
  assert.deepEqual(emptyOps, {
    decisions: [{ itemId: "a", decision: "silent", reason: "x" }],
    notifications: [],
  });
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
    retainMain: async () => undefined,
    habits: {
      getPromptContext: async () => { throw new Error("habits I/O failed"); },
      applyOperations: async () => [],
    },
    runModel: async () => { modelCalled = true; return { ok: false, error: "MODEL_REQUEST_FAILED" }; },
  });
  await service.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await service.ingest([{ source: "sms", externalId: "1", content: "one" }]);
  await assert.rejects(service.runNow(), /habits I\/O failed/);
  const state = base.readState();
  assert.equal(state.runs[0]?.status, "failed");
  assert.equal(state.items[0]?.status, "failed");
  assert.equal(modelCalled, false);
  assert.equal(await service.runDue(), false, "global slot must be released");
});

test("cancellation while prompt context is loading reverts items to pending", async () => {
  const base = fixture();
  const contextGate = deferred<void>();
  let contextStarted = false;
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository: base.repository,
    retainMain: async () => undefined,
    habits: {
      getPromptContext: async () => {
        contextStarted = true;
        await contextGate.promise;
        return { habits: [], unconsolidatedSignals: [], unconsolidatedCount: 0 };
      },
      applyOperations: async () => [],
    },
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
  });
  await service.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await service.ingest([{ source: "sms", externalId: "1", content: "one" }]);
  const running = service.runNow();
  while (!contextStarted) await new Promise((resolve) => setImmediate(resolve));
  const pause = service.pause();
  contextGate.resolve();
  const detail = await running;
  await pause.stopped;
  assert.equal(detail.run.status, "cancelled");
  assert.equal(base.readState().items[0]?.status, "pending");
  assert.equal(base.readState().items[0]?.runId, undefined);
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
  const items = [0, 1, 2, 3, 4].map((index) => ({
    id: `item-${index}`,
    queue: (index === 4 ? "archive" : "realtime") as "archive" | "realtime",
    source: "sms",
    externalId: String(index),
    content: `content-${index}`,
    receivedAt: at,
    acceptedAt: at,
    status: (index === 3 ? "processed" : "pending") as "processed" | "pending",
  }));
  const { repository } = memoryRepo({ items });
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => undefined,
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

test("buildHabitSignal clips items/comments cleanly and preferences expose hot buffer and storage failures loudly", async () => {
  const at = new Date().toISOString();
  const initial: SeedInformationState = {
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
    retainMain: async () => undefined,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
  });

  const built = await service.buildHabitSignal("notification-1", {
    reaction: "like",
    saved: true,
    comments: [{ id: "c1", text: "latest", createdAt: at, updatedAt: at }],
  });
  assert.ok(built);
  assert.equal(built.reaction, "like");
  assert.equal(built.saved, true);
  assert.deepEqual(built.comments, ["latest"]);
  assert.equal(built.items?.[0]?.content.length, 2000);
  assert.equal(built.items?.[0]?.contentTruncated, true);

  const bufferedService = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => undefined,
    habits: {
      getPromptContext: async () => ({
        habits: [],
        unconsolidatedSignals: [built],
        unconsolidatedCount: 1,
      }),
      applyOperations: async () => [],
    },
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
  });
  const preferences = await bufferedService.getPreferences();
  assert.equal(preferences.unconsolidatedFeedbackCount, 1);
  assert.deepEqual(preferences.includes, []);
  assert.deepEqual(preferences.habits, []);

  const failingService = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => undefined,
    habits: {
      getPromptContext: async () => { throw new Error("corrupt habits"); },
      applyOperations: async () => [],
    },
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
  });
  await assert.rejects(failingService.getPreferences(), /corrupt habits/);
});

test("archive channel incrementally updates habits across batches and isolates realtime until runArchive", async () => {
  const { repository } = memoryRepo({
    settings: { enabled: true, batchWindowSeconds: 0 },
  });
  const storedHabits: HabitItem[] = [];
  const captured: Array<{ kind: string; count: number; habitCount: number }> = [];
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
    habits: {
      getPromptContext: async () => ({
        habits: [...storedHabits],
        unconsolidatedSignals: [],
        unconsolidatedCount: 0,
      }),
      applyOperations: async (domain, ops: readonly HabitOperation[], source = "consolidated") => {
        for (const op of ops) {
          if (op.op === "add") {
            const now = new Date().toISOString();
            storedHabits.push({
              id: `hab_${storedHabits.length + 1}`,
              domain,
              text: op.text,
              source,
              createdAt: now,
              updatedAt: now,
            });
          }
        }
        return [...storedHabits];
      },
    },
    runModel: async (input) => {
      captured.push({ kind: input.kind, count: input.items.length, habitCount: input.habits.length });
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
          ...(input.kind === "archive"
            ? { habitOperations: [{ op: "add" as const, text: `归纳规则-${captured.length}` }] }
            : {}),
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

  // 2. 显式触发 runArchive：3 个 archive 批逐步增量累加习惯，最终发 1 条 <= 1200 字简报
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
    { kind: "archive", count: 25, habitCount: 0 },
    { kind: "archive", count: 25, habitCount: 1 },
    { kind: "archive", count: 10, habitCount: 2 },
  ]);
  assert.equal(storedHabits.length, 3);
  assert.equal(briefingInputs.length, 1);
  assert.equal(briefingInputs[0]?.totalScanned, 60);
  assert.equal(briefingInputs[0]?.skippedCount, 0);
  assert.equal(briefingInputs[0]?.candidates.length, 3);
  assert.equal(sentNotifications.length, 1);
  assert.ok(sentNotifications[0]!.text.length <= ARCHIVE_BRIEFING_MAX_LENGTH);

  // 3. 随后的日常实时短信继承归档沉淀的习惯，走单周期直接推送
  await service.ingest([{ source: "sms", externalId: "rt-1", content: "ACTIONABLE 新取件码 9527" }]);
  assert.equal(await service.nextDue(), true);
  assert.equal(await service.runDue(), true);
  assert.equal(captured[3]?.kind, "realtime");
  assert.equal(captured[3]?.habitCount, 3);
  assert.equal(sentNotifications.length, 2);
  assert.equal((await service.getPreferences()).habits.length, 3);
});

test("archive failure stops briefing until retryFailed drains remaining items cleanly", async () => {
  const { repository } = memoryRepo();
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
          habitOperations: [{ op: "add", text: `累计习惯-${round}` }],
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

test("archive content rejection bisects to isolate the poison item and still publishes briefing with skipped count", async () => {
  const { repository } = memoryRepo();
  const sent: Array<{ text: string; id: string }> = [];
  const briefingInputs: InformationBriefingInput[] = [];

  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-bisect",
        notify: async (text, id) => {
          sent.push({ text, id });
          return { notificationId: id, piSessionId: "session-bisect", messageId: `msg-${id}` };
        },
      },
      release: () => undefined,
    }),
    runModel: async (input) => {
      if (input.items.some((item) => item.content.includes("POISON"))) {
        return { ok: false, error: "MODEL_CONTENT_REJECTED" };
      }
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
          habitOperations: [{ op: "add" as const, text: "归纳习惯-快递" }],
        },
      };
    },
    synthesizeBriefing: async (input) => {
      briefingInputs.push(input);
      return {
        ok: true,
        text: `已整理 ${input.totalScanned} 条，${input.candidates.length} 条待办${input.skippedCount > 0 ? `，另有 ${input.skippedCount} 条因内容审核跳过` : ""}。`,
        itemIds: input.candidates.map((c) => c.itemId),
      };
    },
  });

  const contents = Array.from({ length: 10 }, (_v, idx) =>
    idx === 4 ? "POISON sensitive content" : idx === 1 || idx === 7 ? `PICKUP 取件码 ${idx}` : `广告 ${idx}`);
  await service.ingestArchive(contents.map((content, idx) => ({ source: "sms", externalId: `bisect-${idx}`, content })));

  const summary = await service.runArchive();
  assert.equal(summary.status, "partial");
  assert.equal(summary.processedCount, 9);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.remainingPendingCount, 0);
  assert.equal(summary.briefingPublished, true);

  const failedItems = (await service.listItems({ queue: "archive", status: "failed", limit: 10 })).items;
  assert.equal(failedItems.length, 1);
  assert.match(failedItems[0]!.content, /POISON/);

  const runs = (await service.listRuns({ kind: "archive", limit: 50 })).runs;
  // 被拆分的中间 run 也是 MODEL_CONTENT_REJECTED，但只有 itemIds.length === 1 的 run 才真正隔离了条目。
  const rejectedRuns = runs.filter((run) => run.model?.error === "MODEL_CONTENT_REJECTED");
  assert.ok(rejectedRuns.length >= 2, "split parents plus the isolated leaf should all carry MODEL_CONTENT_REJECTED");
  const isolatedLeaf = rejectedRuns.find((run) => run.itemIds.length === 1);
  assert.equal(isolatedLeaf?.status, "failed");
  assert.equal(isolatedLeaf?.itemIds[0], failedItems[0]!.id);

  assert.equal(briefingInputs.length, 1);
  assert.equal(briefingInputs[0]?.totalScanned, 9);
  assert.equal(briefingInputs[0]?.silentCount, 7);
  assert.equal(briefingInputs[0]?.skippedCount, 1);
  assert.equal(briefingInputs[0]?.candidates.length, 2);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /另有 1 条因内容审核跳过/);

  // 第二波归档：上一波被审核跳过的条目既不阻断也不重复计入 skippedCount。
  await service.ingestArchive(
    Array.from({ length: 5 }, (_v, idx) => ({ source: "sms", externalId: `wave2-${idx}`, content: `广告 第二波 ${idx}` })),
  );
  const wave2 = await service.runArchive();
  assert.deepEqual(wave2, {
    status: "completed",
    runsCount: 1,
    processedCount: 5,
    failedCount: 0,
    remainingPendingCount: 0,
    briefingPublished: true,
  });
  assert.equal(briefingInputs.length, 2);
  assert.equal(briefingInputs[1]?.totalScanned, 5);
  assert.equal(briefingInputs[1]?.skippedCount, 0);
});

test("global MODEL_REQUEST_FAILED outage neither bisects nor publishes a premature briefing", async () => {
  const { repository } = memoryRepo();
  const sent: string[] = [];
  let calls = 0;
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-outage",
        notify: async (text, id) => {
          sent.push(text);
          return { notificationId: id, piSessionId: "session-outage", messageId: `msg-${id}` };
        },
      },
      release: () => undefined,
    }),
    runModel: async () => {
      calls++;
      return { ok: false, error: "MODEL_REQUEST_FAILED" };
    },
    synthesizeBriefing: async () => ({ ok: true, text: "不应生成", itemIds: [] }),
  });

  await service.ingestArchive(
    Array.from({ length: 6 }, (_v, idx) => ({ source: "sms", externalId: `outage-${idx}`, content: `广告 ${idx}` })),
  );
  const summary = await service.runArchive();
  assert.equal(summary.status, "partial");
  assert.equal(summary.processedCount, 0);
  assert.equal(summary.failedCount, 6);
  assert.equal(summary.briefingPublished, false);
  assert.equal(calls, 1, "transient outage must fail the whole batch with a single model call");
  assert.equal(sent.length, 0);
});

test("persistent content rejection trips the circuit breaker and leaves remaining items pending", async () => {
  const { repository } = memoryRepo();
  let calls = 0;
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => undefined,
    runModel: async () => {
      calls++;
      return { ok: false, error: "MODEL_CONTENT_REJECTED" };
    },
    synthesizeBriefing: async () => ({ ok: true, text: "不应生成", itemIds: [] }),
  });

  await service.ingestArchive(
    Array.from({ length: 10 }, (_v, idx) => ({ source: "sms", externalId: `cb-${idx}`, content: `内容 ${idx}` })),
  );
  const summary = await service.runArchive();
  assert.equal(summary.status, "partial");
  assert.equal(summary.briefingPublished, false);
  assert.ok(calls < 12, `circuit breaker must stop far earlier than full leaf expansion, got ${calls} calls`);
  const status = await service.getStatus();
  assert.equal(status.archive.pendingCount > 0, true, "remaining items stay pending after circuit break");
  assert.equal(status.archive.failedCount + status.archive.pendingCount, 10);
});

test("pausing mid-bisect reverts every claimed item back to pending", async () => {
  const { repository } = memoryRepo();
  const gate = deferred<void>();
  let started = false;
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => undefined,
    runModel: async (_input, signal) => {
      started = true;
      signal.addEventListener("abort", () => gate.resolve(), { once: true });
      await gate.promise;
      return { ok: false, error: "MODEL_CONTENT_REJECTED" };
    },
  });

  await service.ingestArchive(
    Array.from({ length: 4 }, (_v, idx) => ({ source: "sms", externalId: `pause-${idx}`, content: `内容 ${idx}` })),
  );
  const running = service.runArchive();
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  const pause = service.pause();
  gate.resolve();
  const summary = await running;
  await pause.stopped;
  pause.resume();
  assert.equal(summary.briefingPublished, false);
  const items = (await service.listItems({ queue: "archive", limit: 10 })).items;
  assert.equal(items.filter((item) => item.status === "processing").length, 0);
  assert.equal(items.filter((item) => item.status === "pending").length, 4);
});

test("realtime batch bisect isolates the poison item and still notifies healthy items", async () => {
  const { repository } = memoryRepo({ settings: { enabled: true, batchWindowSeconds: 0 } });
  const sent: Array<{ text: string; id: string }> = [];
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => ({
      conversation: {
        piSessionId: () => "session-rt-bisect",
        notify: async (text, id) => {
          sent.push({ text, id });
          return { notificationId: id, piSessionId: "session-rt-bisect", messageId: `msg-${id}` };
        },
      },
      release: () => undefined,
    }),
    runModel: async (input) => {
      if (input.items.some((item) => item.content.includes("POISON"))) {
        return { ok: false, error: "MODEL_CONTENT_REJECTED" };
      }
      const notifyIds = input.items.filter((item) => item.content.includes("NOTIFY")).map((item) => item.id);
      return {
        ok: true,
        result: {
          decisions: input.items.map((item) => ({
            itemId: item.id,
            decision: notifyIds.includes(item.id) ? "notify" as const : "silent" as const,
            reason: "ok",
          })),
          notifications: notifyIds.length ? [{ itemIds: notifyIds, text: "实时提醒" }] : [],
        },
      };
    },
  });

  await service.ingest([
    { source: "sms", externalId: "rt-a", content: "NOTIFY 重要提醒" },
    { source: "sms", externalId: "rt-poison", content: "POISON sensitive" },
    { source: "sms", externalId: "rt-c", content: "普通广告" },
  ]);
  const finished = await service.runNow();
  assert.equal(finished.run.status, "completed");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.text, "实时提醒");

  const items = (await service.listItems({ limit: 10 })).items;
  const poison = items.find((item) => item.externalId === "rt-poison");
  assert.equal(poison?.status, "failed");
  assert.equal(items.filter((item) => item.status === "processed").length, 2);
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
    { allowNotifications: false, allowHabitOperations: true },
  );
  assert.deepEqual(Object.keys(archiveTool.parameters.properties).sort(), ["decisions", "habitOperations"]);
  const okArchive = await archiveTool.execute("arch", {
    decisions: [{ itemId: "item-1", decision: "silent", reason: "营销" }],
    habitOperations: [{ op: "add", text: "忽略促销短信" }],
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

test("runNow({ retryFailed: true }) requeues failed realtime items and projects decision and reason", async () => {
  const { repository } = memoryRepo({ settings: { enabled: true, batchWindowSeconds: 0 } });
  let round = 0;
  const service = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => undefined,
    runModel: async (input) => {
      round += 1;
      if (round === 1) return { ok: false, error: "MODEL_REQUEST_FAILED" };
      return {
        ok: true,
        result: {
          decisions: input.items.map((item) => ({ itemId: item.id, decision: "silent" as const, reason: "routine verification" })),
          notifications: [],
        },
      };
    },
  });

  await service.ingest([{ source: "sms", externalId: "u-retry-1", content: "login code 1234" }]);
  const failedRun = await service.runNow();
  assert.equal(failedRun.run.status, "failed");

  await assert.rejects(service.runNow(), { code: "NO_PENDING" });
  const retriedRun = await service.runNow({ retryFailed: true });
  assert.equal(retriedRun.run.status, "completed");

  const page = await service.listItems({ limit: 10 });
  assert.equal(page.items[0]?.status, "processed");
  assert.equal(page.items[0]?.decision, "silent");
  assert.equal(page.items[0]?.reason, "routine verification");
});
