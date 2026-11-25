import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHabitsRepository } from "../../src/adapters/storage/habits-repository.js";
import { HABITS_SCHEMA_VERSION, habitsModule } from "../../src/adapters/storage/habits-schema.js";
import { openSqliteDatabase, type ManagedSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { MAX_HABITS_PER_SUBAGENT, type HabitSignalPayload } from "../../src/features/habits/types.js";

const tempDir = (prefix: string) => mkdtemp(join(tmpdir(), `${prefix}-`));

const openHabitsDb = async (directory: string): Promise<ManagedSqliteDatabase> => {
  const managed = await openSqliteDatabase(join(directory, "main.sqlite"));
  await managed.serialize(() => ensureSqliteModules(managed, [habitsModule]));
  return managed;
};

const samplePayload = (targetId: string, reaction: "like" | "dislike" | null = "dislike"): HabitSignalPayload => ({
  targetId,
  kind: "sms_notification",
  summary: `summary-${targetId}`,
  reaction,
  saved: false,
  comments: reaction ? [`note-${targetId}`] : [],
  updatedAt: new Date().toISOString(),
});

test("habits module owns 3 tables and enforces CRUD + 50-item cap", async (t) => {
  const dir = await tempDir("pi-muse-habits-crud");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const managed = await openHabitsDb(dir);
  t.after(() => managed.close());

  assert.equal(habitsModule.id, "habits");
  assert.equal(HABITS_SCHEMA_VERSION, 1);
  assert.deepEqual([...habitsModule.tables], ["habit_domains", "habit_items", "habit_signals"]);

  const repo = createHabitsRepository(managed);
  await repo.validateAll();

  const h1 = await repo.addHabit("sms", "忽略电商大促短信", "manual");
  const h2 = await repo.addHabit("sms", "银行大额账单优先提醒", "consolidated");
  const newsHabit = await repo.addHabit("news", "优先保留开源内核分析", "manual");

  assert.match(h1.id, /^hab_/);
  assert.equal(h1.source, "manual");
  assert.equal(h2.source, "consolidated");
  assert.deepEqual((await repo.listHabits("sms")).map((h) => h.id), [h1.id, h2.id]);
  assert.deepEqual((await repo.listHabits("news")).map((h) => h.id), [newsHabit.id]);

  const updated = await repo.updateHabit("sms", h1.id, "彻底屏蔽促销优惠券");
  assert.equal(updated.text, "彻底屏蔽促销优惠券");
  assert.equal(updated.source, "manual");

  await assert.rejects(() => repo.updateHabit("sms", "missing-id", "x"), { code: "NOT_FOUND" });
  await assert.rejects(() => repo.deleteHabit("sms", "missing-id"), { code: "NOT_FOUND" });

  assert.deepEqual(await repo.deleteHabit("sms", h1.id), { deleted: true, id: h1.id });
  assert.deepEqual((await repo.listHabits("sms")).map((h) => h.id), [h2.id]);

  // Fill up to 50 items total (already 1 left in sms, add 49)
  for (let i = 0; i < MAX_HABITS_PER_SUBAGENT - 1; i++) {
    await repo.addHabit("sms", `习惯条款-${i}`, "manual");
  }
  assert.equal((await repo.listHabits("sms")).length, MAX_HABITS_PER_SUBAGENT);
  await assert.rejects(() => repo.addHabit("sms", "overflow", "manual"), { code: "LIMIT_EXCEEDED" });
});

test("cursor commit atomically updates habits, advances cursor, prunes signals, and protects concurrent manual edits", async (t) => {
  const dir = await tempDir("pi-muse-habits-cursor");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const managed = await openHabitsDb(dir);
  t.after(() => managed.close());
  const repo = createHabitsRepository(managed);

  const initial = await repo.addHabit("sms", "原有习惯A", "consolidated");
  const protectedHabit = await repo.addHabit("sms", "待保护手工习惯", "manual");
  const expectedUpdatedAt = new Map([
    [initial.id, initial.updatedAt],
    [protectedHabit.id, protectedHabit.updatedAt],
  ]);

  // Simulate user editing `protectedHabit` manually BEFORE model batch finishes committing!
  // Force a distinct timestamp to guarantee mismatch even inside the same millisecond.
  managed.database
    .prepare("UPDATE habit_items SET text = ?, updated_at = ? WHERE id = ?")
    .run("用户刚改过的手工版", "2099-01-01T00:00:00.000Z", protectedHabit.id);

  const s1 = await repo.appendSignal("sms", "t1", samplePayload("t1"));
  const s2 = await repo.appendSignal("sms", "t2", samplePayload("t2"));
  const s3 = await repo.appendSignal("sms", "t3", samplePayload("t3"));
  assert.equal((await repo.listUnconsolidatedSignals("sms")).length, 3);

  // Record a failure first: cursor MUST NOT advance and signals stay intact.
  await repo.recordRunFailure({
    domain: "sms",
    status: "failed",
    error: "MODEL_REQUEST_FAILED",
    at: "2026-11-23T01:00:00.000Z",
  });
  let meta = await repo.getSubagentMeta("sms");
  assert.equal(meta.cursorSeq, 0);
  assert.equal(meta.lastRunStatus, "failed");
  assert.equal(meta.lastRunError, "MODEL_REQUEST_FAILED");
  assert.equal((await repo.listUnconsolidatedSignals("sms")).length, 3);

  // Commit batch covering s1..s2 while s3 remains above cutoff!
  await repo.commitConsolidationBatch({
    domain: "sms",
    operations: [
      { op: "edit", id: initial.id, text: "更新后习惯A" },
      { op: "delete", id: protectedHabit.id }, // must be skipped due to optimistic concurrency mismatch!
      { op: "add", text: "新增习惯B" },
      { op: "add", text: "新增习惯B" }, // case/text duplicate skipped silently
    ],
    source: "consolidated",
    advanceCursorToSeq: s2.seq,
    processedCount: 2,
    status: "succeeded",
    at: "2026-11-23T01:05:00.000Z",
    expectedUpdatedAt,
  });

  meta = await repo.getSubagentMeta("sms");
  assert.equal(meta.cursorSeq, s2.seq);
  assert.equal(meta.lastRunStatus, "succeeded");
  assert.equal(meta.lastRunProcessed, 2);
  assert.equal(meta.lastRunError, null);

  const remaining = await repo.listUnconsolidatedSignals("sms");
  assert.deepEqual(remaining.map((r) => r.seq), [s3.seq]);

  const items = await repo.listHabits("sms");
  assert.deepEqual(items.map((h) => h.text), ["更新后习惯A", "用户刚改过的手工版", "新增习惯B"]);
  assert.ok(s1.seq < s2.seq && s2.seq < s3.seq);
});
