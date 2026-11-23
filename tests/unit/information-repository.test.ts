import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInformationRepository } from "../../src/adapters/storage/information-repository.js";
import { smsModule } from "../../src/adapters/storage/sms-schema.js";
import { openSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";

const openTempRepo = async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-info-repo-"));
  const managed = await openSqliteDatabase(join(dir, "main.sqlite"));
  await managed.serialize(() => ensureSqliteModules(managed, [smsModule]));
  return {
    dir,
    managed,
    repository: createInformationRepository(managed),
    cleanup: async () => {
      await managed.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
};

test("information repository serializes concurrent operations safely", async (t) => {
  const ctx = await openTempRepo();
  t.after(ctx.cleanup);

  const results = await Promise.all([
    ctx.repository.saveSettings({ enabled: true, batchWindowSeconds: 10 }),
    ctx.repository.ingestItems(
      "realtime",
      [{ source: "sms", externalId: "c-1", content: "one", receivedAt: "2026-11-23T09:00:00.000Z" }],
      "2026-11-23T09:00:00.000Z",
    ),
    ctx.repository.ingestItems(
      "realtime",
      [{ source: "sms", externalId: "c-2", content: "two", receivedAt: "2026-11-23T09:00:01.000Z" }],
      "2026-11-23T09:00:01.000Z",
    ),
    ctx.repository.saveSettings({ enabled: true, batchWindowSeconds: 30 }),
  ]);

  assert.equal((results[1] as { accepted: unknown[] }).accepted.length, 1);
  assert.equal((results[2] as { accepted: unknown[] }).accepted.length, 1);
  assert.deepEqual(await ctx.repository.getSettings(), { enabled: true, batchWindowSeconds: 30 });
  const list = await ctx.repository.listItems({ limit: 10 });
  assert.equal(list.items.length, 2);
});

test("reconcileOnStart resets pending publications and in-flight running runs cleanly", async (t) => {
  const ctx = await openTempRepo();
  t.after(ctx.cleanup);

  await ctx.repository.saveSettings({ enabled: true, batchWindowSeconds: 15 });
  await ctx.repository.ingestItems(
    "realtime",
    [{ source: "sms", externalId: "r-1", content: "urgent", receivedAt: "2026-11-23T09:00:00.000Z" }],
    "2026-11-23T09:00:00.000Z",
  );
  const batch = await ctx.repository.claimBatch("realtime", {
    forceRealtime: true,
    maxItems: 10,
    maxChars: 10_000,
    now: "2026-11-23T09:00:01.000Z",
  });
  assert.ok(batch);
  await ctx.repository.completeModelRound({
    runId: batch.run.id,
    itemIds: [batch.items[0]!.id],
    decisions: [{ itemId: batch.items[0]!.id, decision: "notify", reason: "urgent" }],
    publications: [{ notificationId: "pub-1", itemIds: [batch.items[0]!.id], text: "urgent", status: "pending" }],
    finishedAt: "2026-11-23T09:00:02.000Z",
  });

  await ctx.repository.reconcileOnStart();
  const runDetail = await ctx.repository.getRun(batch.run.id);
  assert.equal(runDetail?.run.publications[0]?.status, "failed");
  assert.equal(runDetail?.run.publications[0]?.error, "Interrupted by service restart");
});

test("nextRealtimeDue respects batchWindow, enabled flag, and isolates archive items", async (t) => {
  const ctx = await openTempRepo();
  t.after(ctx.cleanup);

  await ctx.repository.saveSettings({ enabled: true, batchWindowSeconds: 60 });
  // Archive items do not trigger realtime readiness.
  await ctx.repository.ingestItems(
    "archive",
    [{ source: "sms", externalId: "arch-only", content: "archive", receivedAt: "2026-11-23T08:00:00.000Z" }],
    "2026-11-23T08:00:00.000Z",
  );
  assert.equal(await ctx.repository.nextRealtimeDue(), false);

  const recent = new Date(Date.now() - 10_000).toISOString();
  await ctx.repository.ingestItems(
    "realtime",
    [{ source: "sms", externalId: "rt-1", content: "realtime", receivedAt: recent }],
    recent,
  );
  assert.equal(await ctx.repository.nextRealtimeDue(), false);

  await ctx.repository.saveSettings({ enabled: true, batchWindowSeconds: 5 });
  assert.equal(await ctx.repository.nextRealtimeDue(), true);

  await ctx.repository.saveSettings({ enabled: false, batchWindowSeconds: 5 });
  assert.equal(await ctx.repository.nextRealtimeDue(), false);
});
