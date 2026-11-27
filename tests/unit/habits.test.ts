import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHabitsRepository } from "../../src/adapters/storage/habits-repository.js";
import { habitsModule } from "../../src/adapters/storage/habits-schema.js";
import { openSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import {
  dedupeLatestSignals,
  formatHabitsForPrompt,
  parseHabitConsolidationResult,
  parseHabitOperationsArray,
} from "../../src/features/habits/operations.js";
import { createHabitsScheduler } from "../../src/features/habits/scheduler.js";
import { createHabitsService } from "../../src/features/habits/service.js";
import type { HabitConsolidateModelInput, HabitSignalPayload } from "../../src/features/habits/types.js";
import { waitForTest } from "../support/http-client.js";

const signalPayload = (
  targetId: string,
  reaction: "like" | "dislike" | null = "dislike",
  comments: string[] = ["不需要此类推广"],
): HabitSignalPayload => ({
  targetId,
  kind: "sms_notification",
  summary: `Msg ${targetId}`,
  reaction,
  saved: false,
  comments,
  updatedAt: new Date().toISOString(),
});

test("habit operations validation and interleaved target deduplication prevent losing newer feedback", () => {
  const existing = new Set(["hab_1", "hab_2"]);
  assert.deepEqual(
    parseHabitOperationsArray(
      [
        { op: "add", text: "  新规则  " },
        { op: "edit", id: "hab_1", text: "修改规则" },
        { op: "delete", id: "hab_2" },
      ],
      { existingIds: existing },
    ),
    [
      { op: "add", text: "新规则" },
      { op: "edit", id: "hab_1", text: "修改规则" },
      { op: "delete", id: "hab_2" },
    ],
  );
  assert.deepEqual(
    parseHabitConsolidationResult({ operations: [{ op: "add", text: "ok" }] }, existing),
    [{ op: "add", text: "ok" }],
  );

  for (const invalid of [
    { operations: [{ op: "add", id: "hab_1", text: "x" }] },
    { operations: [{ op: "edit", id: "hab_missing", text: "x" }] },
    { operations: [{ op: "delete", id: "hab_1", text: "forbidden" }] },
    { operations: [{ op: "edit", id: "hab_1", text: "a" }, { op: "delete", id: "hab_1" }] },
    { operations: [{ op: "add", text: "   " }] },
    { operations: [{ op: "add", text: "x".repeat(301) }] },
    { operations: [], extra: 1 },
  ]) {
    assert.throws(() => parseHabitConsolidationResult(invalid, existing), { code: "INVALID_INPUT" });
  }

  // Interleaved targets: A(seq 1), B(seq 2), A(seq 3) -> sorted by maxSeq ASC gives [B@2, A@3]!
  const deduped = dedupeLatestSignals([
    { seq: 1, domain: "sms", targetId: "A", payload: signalPayload("A", "like"), createdAt: "t1" },
    { seq: 2, domain: "sms", targetId: "B", payload: signalPayload("B", "dislike"), createdAt: "t2" },
    { seq: 3, domain: "sms", targetId: "A", payload: signalPayload("A", "dislike"), createdAt: "t3" },
  ]);
  assert.deepEqual(deduped.map((d) => ({ targetId: d.targetId, maxSeq: d.maxSeq, reaction: d.payload.reaction })), [
    { targetId: "B", maxSeq: 2, reaction: "dislike" },
    { targetId: "A", maxSeq: 3, reaction: "dislike" },
  ]);

  assert.equal(formatHabitsForPrompt([]), "(none)");
  assert.equal(
    formatHabitsForPrompt([
      { id: "hab_a", subagentId: "sms", text: "规则A", source: "consolidated", createdAt: "t", updatedAt: "t" },
    ]),
    "- [hab_a] 规则A",
  );
});

test("habits service batches unconsolidated signals losslessly, preserves cursor on failure, and auto-triggers on distinct targets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-habits-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const managed = await openSqliteDatabase(join(dir, "main.sqlite"));
  t.after(() => managed.close());
  await managed.serialize(() => ensureSqliteModules(managed, [habitsModule]));

  const modelBatches: HabitConsolidateModelInput[] = [];
  let failNext = false;
  let gate!: () => void;
  let blockConsolidation: Promise<void> | undefined;

  const service = createHabitsService({
    repository: createHabitsRepository(managed),
    domains: [
      { id: "sms", name: "短信", summary: "短信筛选", readInstructions: async () => "显式指令" },
      { id: "demo", name: "演示", summary: "演示筛选" },
    ],
    autoThreshold: 3,
    intervalMs: 10_000,
    signalBatchSize: 2,
    consolidateModel: async (input) => {
      modelBatches.push(input);
      if (blockConsolidation) await blockConsolidation;
      if (failNext) return { ok: false, error: "MODEL_REQUEST_FAILED" };
      return {
        ok: true,
        operations: [{ op: "add", text: `批${modelBatches.length}:${input.signals.map((s) => s.targetId).join(",")}` }],
      };
    },
  });
  t.after(() => service.close());

  await assert.rejects(() => service.getOverview("Bad!"), { code: "INVALID_INPUT" });
  await assert.rejects(() => service.getOverview("unknown"), { code: "NOT_FOUND" });

  // Toggling feedback 5 times on ONE target only counts as 1 unconsolidated target -> MUST NOT auto-trigger threshold=3
  for (const r of ["like", "dislike", "like", "dislike", "like"] as const) {
    await service.recordSignal("sms", "msg-1", signalPayload("msg-1", r));
  }
  assert.equal((await service.getOverview("sms")).unconsolidatedCount, 1);
  assert.equal(modelBatches.length, 0);

  // Add second active target -> count=2, still below 3
  await service.recordSignal("sms", "msg-2", signalPayload("msg-2", "dislike"));
  assert.equal((await service.getOverview("sms")).unconsolidatedCount, 2);
  assert.equal(modelBatches.length, 0);

  // Failure on manual consolidate MUST preserve hot buffer and cursorSeq = 0!
  failNext = true;
  const failedOverview = await service.consolidate("sms");
  assert.equal(failedOverview.lastRunStatus, "failed");
  assert.equal(failedOverview.cursorSeq, 0);
  assert.equal(failedOverview.unconsolidatedCount, 2);
  assert.equal(failedOverview.habits.length, 0);

  // Now recover and add 3rd distinct target -> auto-triggers consolidation in background across 2 batches (size=2 -> 2 + 1)!
  failNext = false;
  await service.recordSignal("sms", "msg-3", signalPayload("msg-3", "dislike"));
  const settled = await waitForTest(async () => {
    const ov = await service.getOverview("sms");
    return !ov.running && ov.unconsolidatedCount === 0 ? ov : undefined;
  }, "auto threshold consolidation");

  assert.equal(settled.lastRunStatus, "succeeded");
  assert.equal(settled.habits.length, 2);
  assert.equal(settled.habits[0]?.text, "批2:msg-1,msg-2");
  assert.equal(settled.habits[1]?.text, "批3:msg-3");
  assert.deepEqual((await service.getPromptContext("sms")).unconsolidatedSignals, []);

  // Busy guard prevents concurrent manual consolidate on the same domain
  blockConsolidation = new Promise<void>((resolve) => { gate = resolve; });
  await service.recordSignal("demo", "art-1", signalPayload("art-1", "dislike"));
  const firstRun = service.consolidate("demo");
  await waitForTest(async () => ((await service.getOverview("demo")).running ? true : undefined), "demo running");
  await assert.rejects(() => service.consolidate("demo"), { code: "BUSY" });
  gate();
  blockConsolidation = undefined;
  const demoDone = await firstRun;
  assert.equal(demoDone.habits.length, 1);
});

test("clearing feedback before consolidation removes the target from hot buffer and skips model invocation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-habits-cleared-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const managed = await openSqliteDatabase(join(dir, "main.sqlite"));
  t.after(() => managed.close());
  await managed.serialize(() => ensureSqliteModules(managed, [habitsModule]));

  let modelCalls = 0;
  const service = createHabitsService({
    repository: createHabitsRepository(managed),
    domains: [{ id: "sms", name: "短信", summary: "短信" }],
    intervalMs: 10,
    consolidateModel: async () => {
      modelCalls++;
      return { ok: true, operations: [] };
    },
  });
  const scheduler = createHabitsScheduler(service, { pollIntervalMs: 15, intervalMs: 10 });
  t.after(() => scheduler.close());

  await service.recordSignal("sms", "msg-x", signalPayload("msg-x", "like", []));
  assert.equal((await service.getPromptContext("sms")).unconsolidatedSignals.length, 1);
  // Undo like -> cleared signal overwrites target in dedupe
  await service.recordSignal("sms", "msg-x", signalPayload("msg-x", null, []));
  assert.equal((await service.getPromptContext("sms")).unconsolidatedSignals.length, 0);

  const ov = await service.consolidate("sms");
  assert.equal(modelCalls, 0);
  assert.equal(ov.lastRunStatus, "skipped");
  assert.ok(ov.cursorSeq > 0);

  // Scheduler triggers runDue when interval elapsed and active signal exists
  await service.recordSignal("sms", "msg-y", signalPayload("msg-y", "dislike"));
  scheduler.start();
  await waitForTest(async () => ((await service.getOverview("sms")).unconsolidatedCount === 0 ? true : undefined), "scheduler runDue", 2000);
  assert.equal(modelCalls, 1);
});
