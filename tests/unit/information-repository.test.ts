import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createInformationRepository,
  parseInformationState,
} from "../../src/adapters/storage/information-repository.js";
import { smsModule } from "../../src/adapters/storage/sms-schema.js";
import { openSqliteDatabase, type ManagedSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { defaultInformationState, type InformationState } from "../../src/features/information/types.js";

const openSmsRepository = async (directory: string): Promise<{
  managed: ManagedSqliteDatabase;
  repository: ReturnType<typeof createInformationRepository>;
}> => {
  const managed = await openSqliteDatabase(join(directory, "main.sqlite"));
  await managed.serialize(() => ensureSqliteModules(managed, [smsModule]));
  return { managed, repository: createInformationRepository(managed) };
};

const deferred = () => {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => { finish = resolve; });
  return { promise, finish };
};

test("updates serialize concurrent callbacks on the repository", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-information-repository-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { managed, repository } = await openSmsRepository(dataDir);
  t.after(() => managed.close());

  const holding = deferred();
  const writing = repository.update(async (state) => {
    await holding.promise;
    return { state: { ...state, preferences: { learnedNotes: "serialized" } }, result: undefined };
  });
  const next = repository.update((state) => ({
    state: { ...state, settings: { ...state.settings, enabled: true } },
    result: state.preferences.learnedNotes,
  }));
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
  const { managed, repository } = await openSmsRepository(dataDir);
  t.after(() => managed.close());
  const at = new Date().toISOString();
  const state: InformationState = {
    ...defaultInformationState(),
    settings: { enabled: true, batchWindowSeconds: 0 },
    items: [
      { id: "item-running", queue: "realtime", source: "sms", externalId: "1", content: "one", receivedAt: at, acceptedAt: at, status: "processing", runId: "run-running" },
      { id: "item-completed", queue: "realtime", source: "sms", externalId: "2", content: "two", receivedAt: at, acceptedAt: at, status: "processed", runId: "run-completed" },
    ],
    runs: [
      { id: "run-running", kind: "realtime", itemIds: ["item-running"], status: "running", createdAt: at, startedAt: at, publications: [] },
      {
        id: "run-completed", kind: "realtime", itemIds: ["item-completed"], status: "completed",
        createdAt: at, startedAt: at, finishedAt: at, model: { status: "succeeded" },
        decisions: [{ itemId: "item-completed", decision: "notify", reason: "test" }],
        publications: [{ notificationId: "n-pending", itemIds: ["item-completed"], text: "pending", status: "pending" }],
      },
    ],
  };
  await repository.update(() => ({ state, result: undefined }));
  await repository.reconcileOnStart();
  const reconciled = await repository.read();
  assert.equal(reconciled.runs[0]?.status, "failed");
  assert.equal(reconciled.runs[0]?.model?.error, "Interrupted by service restart");
  assert.equal(reconciled.items[0]?.status, "pending");
  assert.equal(reconciled.items[0]?.runId, undefined);
  assert.equal(reconciled.runs[1]?.status, "completed");
  assert.equal(reconciled.runs[1]?.publications[0]?.status, "failed");
  assert.equal(reconciled.runs[1]?.publications[0]?.error, "Interrupted by service restart");
});

test("v2 state schema rejects legacy fields and preserves exact Clean Break defaults", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-information-repository-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { managed, repository } = await openSmsRepository(dataDir);
  t.after(() => managed.close());
  const at = new Date().toISOString();

  assert.throws(() => parseInformationState({
    schemaVersion: 1,
    settings: { enabled: true, batchWindowSeconds: 0, mode: "notifications" },
    preferences: { learnedNotes: "" },
    items: [],
    runs: [],
  }));

  await repository.update(() => ({
    state: parseInformationState({
      schemaVersion: 2,
      settings: { enabled: true, batchWindowSeconds: 0 },
      preferences: { learnedNotes: "关注取件码" },
      items: [{
        id: "item-1", queue: "realtime", source: "sms", externalId: "1",
        content: "original", receivedAt: at, acceptedAt: at, status: "pending",
      }],
      runs: [],
    }),
    result: undefined,
  }));
  const state = await repository.read();
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.preferences.learnedNotes, "关注取件码");
  assert.equal(state.items[0]?.queue, "realtime");
});

test("nextRealtimeDue checks only queue=realtime without triggering on archive items", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-information-repository-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { managed, repository } = await openSmsRepository(dataDir);
  t.after(() => managed.close());
  const at = new Date(Date.now() - 60_000).toISOString();

  assert.equal(await repository.nextRealtimeDue(), false);
  await repository.update((state) => ({
    state: {
      ...state,
      settings: { enabled: true, batchWindowSeconds: 0 },
      items: [{
        id: "arch-1", queue: "archive", source: "sms", externalId: "a1",
        content: "old sms", receivedAt: at, acceptedAt: at, status: "pending",
      }],
    },
    result: undefined,
  }));
  assert.equal(await repository.nextRealtimeDue(), false, "archive queue must never wake realtime scheduler");

  await repository.update((state) => ({
    state: {
      ...state,
      items: [
        ...state.items,
        {
          id: "rt-1", queue: "realtime", source: "sms", externalId: "r1",
          content: "new sms", receivedAt: at, acceptedAt: at, status: "pending",
        },
      ],
    },
    result: undefined,
  }));
  assert.equal(await repository.nextRealtimeDue(), true);

  await repository.update((state) => ({
    state: { ...state, settings: { enabled: false, batchWindowSeconds: 0 } },
    result: undefined,
  }));
  assert.equal(await repository.nextRealtimeDue(), false);
});
