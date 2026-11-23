import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules, SQLITE_MODULE_LEDGER_TABLE } from "../../src/adapters/storage/sqlite-modules.js";
import { createInformationRepository } from "../../src/adapters/storage/information-repository.js";
import { SMS_SCHEMA_VERSION, smsModule } from "../../src/adapters/storage/sms-schema.js";

const openTestSms = async (t: TestContext, directory?: string) => {
  const ownsDir = directory === undefined;
  const dir = directory ?? await mkdtemp(join(tmpdir(), "pi-muse-sms-sqlite-"));
  const managed = await openSqliteDatabase(join(dir, "main.sqlite"));
  await managed.serialize(() => ensureSqliteModules(managed, [smsModule]));
  t.after(async () => {
    await managed.close();
    if (ownsDir) await rm(dir, { recursive: true, force: true });
  });
  return { dir, managed, repository: createInformationRepository(managed) };
};

test("sms sqlite schema v4 creates expected tables, indexes, and persists across reopen", async (t) => {
  assert.equal(SMS_SCHEMA_VERSION, 4);
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-sms-reopen-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await openTestSms(t, dir);
  const tableRows = first.managed.database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'sms_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  assert.deepEqual(tableRows.map((row) => row.name), [...smsModule.tables].sort());

  const indexRows = first.managed.database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'idx_sms_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    indexRows.map((row) => row.name),
    [
      "idx_sms_decisions_item",
      "idx_sms_items_accepted",
      "idx_sms_items_queue_status",
      "idx_sms_runs_started",
    ],
  );

  assert.deepEqual(await first.repository.getSettings(), { enabled: false, batchWindowSeconds: 15 });
  await first.repository.saveSettings({ enabled: true, batchWindowSeconds: 120 });

  const now = "2026-11-23T08:00:00.000Z";
  const ingested = await first.repository.ingestItems(
    "realtime",
    [
      { source: "sms", externalId: "ext-1", title: "Bank", content: "Card spent 100", receivedAt: now },
      { source: "sms", externalId: "ext-2", content: "50% sale coupon", receivedAt: now },
    ],
    now,
  );
  assert.equal(ingested.accepted.length, 2);

  // Claim and finish round with explicit notify + silent decisions and publication receipts.
  const claimed = await first.repository.claimBatch("realtime", {
    forceRealtime: true,
    maxItems: 50,
    maxChars: 12000,
    now,
  });
  assert.ok(claimed);
  assert.equal(claimed.items.length, 2);
  await first.repository.completeModelRound({
    runId: claimed.run.id,
    itemIds: claimed.items.map((item) => item.id),
    decisions: [
      { itemId: claimed.items[0]!.id, decision: "notify", reason: "transaction alert" },
      { itemId: claimed.items[1]!.id, decision: "silent", reason: "marketing promotion" },
    ],
    publications: [
      {
        notificationId: "notif-1",
        itemIds: [claimed.items[0]!.id],
        text: "Bank card spent 100",
        status: "pending",
      },
    ],
    finishedAt: "2026-11-23T08:00:05.000Z",
  });
  await first.repository.updatePublication(claimed.run.id, "notif-1", {
    status: "published",
    receipt: { notificationId: "notif-1", piSessionId: "pi-1", messageId: "msg-1" },
  });
  await first.repository.finalizeDelivery(claimed.run.id, "2026-11-23T08:00:06.000Z", "Cancelled");
  await first.managed.close();

  const second = await openTestSms(t, dir);
  assert.deepEqual(await second.repository.getSettings(), { enabled: true, batchWindowSeconds: 120 });
  const page = await second.repository.listItems({ limit: 10 });
  assert.equal(page.items.length, 2);
  assert.equal(page.hasMore, false);
  const item1 = page.items.find((entry) => entry.externalId === "ext-1");
  const item2 = page.items.find((entry) => entry.externalId === "ext-2");
  assert.equal(item1?.decision, "notify");
  assert.equal(item1?.reason, "transaction alert");
  assert.equal(item2?.decision, "silent");
  assert.equal(item2?.reason, "marketing promotion");

  const detail = await second.repository.getItem(item1!.id);
  assert.equal(detail?.item.decision, "notify");
  assert.equal(detail?.runs.length, 1);
  assert.equal(detail?.runs[0]?.publications[0]?.status, "published");
});

test("sms sqlite direct cursor pagination, requeueFailed, and reconcileOnStart behave cleanly", async (t) => {
  const { repository, managed } = await openTestSms(t);
  await repository.saveSettings({ enabled: true, batchWindowSeconds: 15 });
  await repository.ingestItems(
    "realtime",
    [
      { source: "sms", externalId: "1", content: "one", receivedAt: "2026-11-23T08:00:01.000Z" },
      { source: "sms", externalId: "2", content: "two", receivedAt: "2026-11-23T08:00:02.000Z" },
    ],
    "2026-11-23T08:00:01.000Z",
  );
  await repository.ingestItems(
    "archive",
    [{ source: "sms", externalId: "3", content: "three", receivedAt: "2026-11-23T08:00:03.000Z" }],
    "2026-11-23T08:00:02.000Z",
  );

  const page1 = await repository.listItems({ limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.hasMore, true);
  const last1 = page1.items.at(-1)!;
  const page2 = await repository.listItems({ limit: 2, after: { at: last1.acceptedAt, id: last1.id } });
  assert.equal(page2.items.length, 1);
  assert.equal(page2.hasMore, false);

  // Simulate interrupted running run + failed item on realtime queue.
  const rtBatch = await repository.claimBatch("realtime", {
    forceRealtime: true,
    maxItems: 10,
    maxChars: 10_000,
    now: "2026-11-23T08:01:00.000Z",
  });
  assert.ok(rtBatch);
  await repository.markRunFailed(
    rtBatch.run.id,
    [rtBatch.items[0]!.id],
    "model timeout",
    "2026-11-23T08:01:05.000Z",
  );
  // Second item left processing if partial, or ingest + fail: claim single or revert not tested directly here, test requeueFailed:
  assert.equal(await repository.requeueFailed("archive"), 0);
  assert.equal(await repository.requeueFailed("realtime"), 1);
  const summary = await repository.getStatusSummary();
  assert.equal(summary.failedCount, 0);
  assert.equal(summary.pendingCount, 1);

  // Now create an in-flight run with pending publication and test reconcileOnStart.
  const secondBatch = await repository.claimBatch("realtime", {
    forceRealtime: true,
    maxItems: 10,
    maxChars: 10_000,
    now: "2026-11-23T08:02:00.000Z",
  });
  assert.ok(secondBatch);
  await repository.completeModelRound({
    runId: secondBatch.run.id,
    itemIds: secondBatch.items.map((entry) => entry.id),
    decisions: secondBatch.items.map((entry) => ({ itemId: entry.id, decision: "notify", reason: "urgent" })),
    publications: [{
      notificationId: "notif-interrupted",
      itemIds: secondBatch.items.map((entry) => entry.id),
      text: "urgent",
      status: "pending",
    }],
    finishedAt: "2026-11-23T08:02:02.000Z",
  });
  await repository.reconcileOnStart();
  const reconciledRun = await repository.getRun(secondBatch.run.id);
  assert.equal(reconciledRun?.run.publications[0]?.status, "failed");
  assert.match(reconciledRun?.run.publications[0]?.error ?? "", /Interrupted by service restart/);

  // Force an uncompleted running run directly and verify reconcile resets processing items to pending.
  managed.database.prepare("UPDATE sms_runs SET status = 'running', finished_at = NULL, model_status = NULL WHERE id = ?").run(secondBatch.run.id);
  managed.database.prepare("UPDATE sms_items SET status = 'processing' WHERE id = ?").run(secondBatch.items[0]!.id);
  await repository.reconcileOnStart();
  const abortedRun = await repository.getRun(secondBatch.run.id);
  assert.equal(abortedRun?.run.status, "failed");
  const resetItem = await repository.getItem(secondBatch.items[0]!.id);
  assert.equal(resetItem?.item.status, "pending");
  assert.equal(resetItem?.item.runId, undefined);
});

test("pruneHistory preserves pending/processing/failed items and removes excess terminal items and orphaned runs", async (t) => {
  const { repository } = await openTestSms(t);
  await repository.saveSettings({ enabled: true, batchWindowSeconds: 15 });
  for (let i = 0; i < 4; i++) {
    const tAt = `2026-11-23T08:00:0${i}.000Z`;
    await repository.ingestItems(
      "realtime",
      [{ source: "sms", externalId: `done-${i}`, content: `msg ${i}`, receivedAt: tAt }],
      tAt,
    );
    const claimed = await repository.claimBatch("realtime", {
      forceRealtime: true,
      maxItems: 1,
      maxChars: 1000,
      now: tAt,
    });
    assert.ok(claimed);
    await repository.completeModelRound({
      runId: claimed.run.id,
      itemIds: [claimed.items[0]!.id],
      decisions: [{ itemId: claimed.items[0]!.id, decision: "silent", reason: "ok" }],
      publications: [],
      finishedAt: tAt,
    });
  }
  await repository.ingestItems(
    "realtime",
    [{ source: "sms", externalId: "pending-keep", content: "keep me", receivedAt: "2026-11-23T08:01:00.000Z" }],
    "2026-11-23T08:01:00.000Z",
  );

  const deleted = await repository.pruneHistory({ maxProcessedRealtimeItems: 2, maxProcessedArchiveItems: 2 });
  assert.deepEqual(deleted, { deletedItems: 2, deletedRuns: 2 });
  const all = await repository.listItems({ limit: 20 });
  assert.equal(all.items.length, 3);
  assert.ok(all.items.some((entry) => entry.externalId === "pending-keep" && entry.status === "pending"));
  const runs = await repository.listRuns({ limit: 20 });
  assert.equal(runs.runs.length, 2);
});

test("validateAll rejects corrupted publications_json and missing sms module registration", async (t) => {
  const { repository, managed } = await openTestSms(t);
  await repository.saveSettings({ enabled: true, batchWindowSeconds: 15 });
  await repository.ingestItems(
    "realtime",
    [{ source: "sms", externalId: "v-1", content: "check", receivedAt: "2026-11-23T08:00:00.000Z" }],
    "2026-11-23T08:00:00.000Z",
  );
  const batch = await repository.claimBatch("realtime", {
    forceRealtime: true,
    maxItems: 5,
    maxChars: 1000,
    now: "2026-11-23T08:00:01.000Z",
  });
  assert.ok(batch);
  managed.database.prepare("UPDATE sms_runs SET publications_json = '{bad' WHERE id = ?").run(batch.run.id);
  await assert.rejects(repository.validateAll(), /corrupted sms run publications/);

  managed.database.prepare("UPDATE sms_runs SET publications_json = '[]' WHERE id = ?").run(batch.run.id);
  managed.database.prepare(`DELETE FROM ${SQLITE_MODULE_LEDGER_TABLE} WHERE module = ?`).run(smsModule.id);
  await assert.rejects(createInformationRepository(managed).validateAll(), /module sms is not registered|missing schema ledger/);
});
