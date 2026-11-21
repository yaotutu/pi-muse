import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInformationRepository, parseInformationState } from "../../src/adapters/storage/information-repository.js";
import { smsModule } from "../../src/adapters/storage/sms-schema.js";
import { openSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { defaultInformationState, type InformationState } from "../../src/features/information/types.js";

const openRepository = async (directory: string) => {
  const managed = await openSqliteDatabase(join(directory, "main.sqlite"));
  await managed.serialize(() => ensureSqliteModules(managed, [smsModule]));
  return { managed, repository: createInformationRepository(managed) };
};

const deferred = () => {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => { finish = resolve; });
  return { promise, finish };
};

test("global information repository serializes updates without losing pending writes", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-information-repository-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { managed, repository } = await openRepository(dataDir);
  t.after(() => managed.close());

  assert.deepEqual(await repository.read(), defaultInformationState());
  const holding = deferred();
  const writing = repository.update(async (state) => {
    await holding.promise;
    return { state: { ...state, preferences: { learnedNotes: "serialized" } }, result: undefined };
  });
  const next = repository.update((state) => ({ state: { ...state, settings: { ...state.settings, enabled: true } }, result: state.preferences.learnedNotes }));
  holding.finish();
  await writing;
  assert.equal(await next, "serialized");
  const persisted = await repository.read();
  assert.equal(persisted.settings.enabled, true);
  assert.equal(persisted.preferences.learnedNotes, "serialized");
});

test("startup reconcile closes interrupted models and completed pending publications", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-information-repository-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { managed, repository } = await openRepository(dataDir);
  t.after(() => managed.close());
  const at = new Date().toISOString();
  const state: InformationState = {
    ...defaultInformationState(),
    settings: { enabled: true, batchWindowSeconds: 0, mode: "notifications" },
    items: [
      { id: "item-running", source: "rss", externalId: "1", content: "one", receivedAt: at, acceptedAt: at, status: "processing", runId: "run-running" },
      { id: "item-completed", source: "rss", externalId: "2", content: "two", receivedAt: at, acceptedAt: at, status: "processed", runId: "run-completed" },
    ],
    runs: [
      { id: "run-running", itemIds: ["item-running"], status: "running", createdAt: at, startedAt: at, publications: [] },
      {
        id: "run-completed", itemIds: ["item-completed"], status: "completed",
        createdAt: at, startedAt: at, model: { status: "succeeded" },
        decisions: [{ itemId: "item-completed", decision: "notify", reason: "test" }],
        publications: [{ notificationId: "notification", itemIds: ["item-completed"], text: "test", status: "pending" }],
      },
    ],
  };
  await repository.update((current) => ({ state, result: current }), { allowCreate: true });
  await repository.reconcileOnStart();
  const reconciled = await repository.read();
  assert.equal(reconciled.items[0]?.status, "failed");
  assert.equal(reconciled.runs[0]?.status, "failed");
  assert.equal(reconciled.runs[1]?.model?.status, "succeeded");
  assert.equal(reconciled.runs[1]?.publications[0]?.status, "failed");
});

test("additive information fields default without discarding an existing valid state", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-information-repository-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { managed, repository } = await openRepository(dataDir);
  t.after(() => managed.close());
  const at = new Date().toISOString();
  await repository.update(() => ({
    state: parseInformationState({
      schemaVersion: 1,
      settings: { enabled: true, batchWindowSeconds: 0 },
      preferences: {},
      items: [{
        id: "item-1", source: "rss", externalId: "1",
        content: "original", receivedAt: at, acceptedAt: at, status: "pending",
      }],
      runs: [],
    }),
    result: undefined,
  }), { allowCreate: true });
  const state = await repository.read();
  assert.equal(state.settings.mode, "notifications");
  assert.equal(state.preferences.learnedNotes, "");
  assert.equal(state.articleFeedback.length, 0);
  assert.equal(state.items[0]?.content, "original");
});

test("zero-candidate initial briefing publication with empty itemIds persists cleanly to SQLite", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-information-repository-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { managed, repository } = await openRepository(dataDir);
  t.after(() => managed.close());
  const at = new Date().toISOString();
  await repository.update(() => ({
    state: parseInformationState({
      schemaVersion: 1,
      settings: { enabled: true, batchWindowSeconds: 15, mode: "notifications" },
      preferences: { learnedNotes: "已整理偏好" },
      items: [{
        id: "item-silent",
        source: "sms",
        externalId: "silent-1",
        content: "促销短信",
        receivedAt: at,
        acceptedAt: at,
        status: "processed",
        runId: "run-zero-briefing",
      }],
      runs: [{
        id: "run-zero-briefing",
        kind: "initial_summary",
        itemIds: ["item-silent"],
        status: "completed",
        createdAt: at,
        startedAt: at,
        finishedAt: at,
        model: { status: "succeeded" },
        decisions: [{ itemId: "item-silent", decision: "silent", reason: "促销营销" }],
        publications: [{
          notificationId: "info-notification-zero",
          itemIds: [],
          text: "已梳理历史短信，当前无待办事项。",
          status: "published",
          receipt: { notificationId: "info-notification-zero", piSessionId: "pi-1", messageId: "msg-1" },
        }],
      }],
      initialAnalysisCompleted: true,
    }),
    result: undefined,
  }), { allowCreate: true });
  const persisted = await repository.read();
  assert.equal(persisted.runs[0]?.publications[0]?.itemIds.length, 0);
  assert.equal(persisted.runs[0]?.publications[0]?.text, "已梳理历史短信，当前无待办事项。");
  assert.equal(persisted.initialAnalysisCompleted, true);
});
