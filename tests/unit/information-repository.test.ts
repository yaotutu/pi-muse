import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDataLayout } from "../../src/adapters/storage/data-layout.js";
import { createInformationRepository } from "../../src/adapters/storage/information-repository.js";
import { defaultInformationState, type InformationState } from "../../src/features/information/types.js";

const deferred = () => {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => { finish = resolve; });
  return { promise, finish };
};

test("global information repository serializes updates without losing pending writes", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-information-repository-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = createInformationRepository(createDataLayout(dataDir));
  assert.deepEqual(await repository.read(), defaultInformationState());
  assert.equal(existsSync(join(dataDir, "information", "sms.json")), false);
  const holding = deferred();
  const writing = repository.update(async (state) => {
    await holding.promise;
    return { state: { ...state, preferences: { notes: "serialized", learnedNotes: "" } }, result: undefined };
  });
  const next = repository.update((state) => ({ state: { ...state, settings: { ...state.settings, enabled: true } }, result: state.preferences.notes }));
  holding.finish();
  await writing;
  assert.equal(await next, "serialized");
  const persisted = await repository.read();
  assert.equal(persisted.settings.enabled, true);
  assert.equal(persisted.preferences.notes, "serialized");
  assert.equal(existsSync(join(dataDir, "information", "sms.json")), true);
});

test("startup reconcile closes interrupted models and completed pending publications", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-information-repository-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = createInformationRepository(createDataLayout(dataDir));
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

test("additive information fields default without discarding an existing valid document", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-information-repository-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const at = new Date().toISOString();
  await mkdir(join(dataDir, "information"), { recursive: true });
  await writeFile(join(dataDir, "information", "sms.json"), JSON.stringify({
    schemaVersion: 1,
    settings: { enabled: true, batchWindowSeconds: 0 },
    preferences: { notes: "keep me" },
    items: [{
      id: "item-1", source: "rss", externalId: "1",
      content: "original", receivedAt: at, acceptedAt: at, status: "pending",
    }],
    runs: [],
  }));
  const repository = createInformationRepository(createDataLayout(dataDir));
  const state = await repository.read();
  assert.equal(state.settings.mode, "notifications");
  assert.equal(state.preferences.notes, "keep me");
  assert.equal(state.preferences.learnedNotes, "");
  assert.deepEqual(state.articleFeedback, []);
  assert.equal(state.items[0]?.content, "original");
});
