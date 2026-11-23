import { memoryInformationRules } from "../support/information-rules.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { smsModule } from "../../src/adapters/storage/sms-schema.js";
import { createInformationRepository } from "../../src/adapters/storage/information-repository.js";
import { createInformationRoutes } from "../../src/http/routes/information.js";
import { createInformationService } from "../../src/features/information/service.js";
import type { HttpDependencies } from "../../src/bootstrap/types.js";

const createTempRepository = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-info-routes-"));
  const managed = await openSqliteDatabase(join(dir, "main.sqlite"));
  await managed.serialize(() => ensureSqliteModules(managed, [smsModule]));
  t.after(async () => {
    await managed.close();
    await rm(dir, { recursive: true, force: true });
  });
  return createInformationRepository(managed);
};

test("global preferences save instructions cleanly without retaining main", async (t) => {
  const repository = await createTempRepository(t);
  let retained = false;
  const information = createInformationService({
    instructions: memoryInformationRules("old"),
    repository,
    retainMain: async () => {
      retained = true;
      return undefined;
    },
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
  });
  const app = createInformationRoutes({ information } as unknown as HttpDependencies);
  const response = await app.request("/preferences", {
    method: "PUT",
    body: JSON.stringify({ instructions: "latest" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    instructions: "latest",
    includes: [],
    habits: [],
    unconsolidatedFeedbackCount: 0,
  });
  assert.equal(retained, false);
});

test("POST runs returns the cancelled record when pause aborts while model is running", async (t) => {
  const repository = await createTempRepository(t);
  let modelStarted = false;
  let releaseModel!: () => void;
  const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
  const information = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => undefined,
    runModel: async (_input, signal) => {
      modelStarted = true;
      signal.addEventListener("abort", () => releaseModel(), { once: true });
      await modelGate;
      return { ok: false, error: "CANCELLED" };
    },
  });
  await information.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await information.ingest([{ source: "rss", externalId: "1", content: "one" }]);

  const app = createInformationRoutes({
    conversationHub: {},
    information,
  } as unknown as HttpDependencies);
  const responsePromise = app.request("/runs", {
    method: "POST",
    body: "{}",
  });
  t.after(() => { releaseModel(); });
  const deadline = Date.now() + 2000;
  while (!modelStarted && Date.now() < deadline && !t.signal.aborted) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(modelStarted, "run route must invoke model");
  const pause = information.pause();
  releaseModel();

  const response = await responsePromise;
  assert.equal(response.status, 200);
  const body = await response.json() as { run: { status: string } };
  assert.equal(body.run.status, "cancelled");
  await pause.stopped;
  pause.resume();
});

test("POST runs accepts retryFailed to requeue failed realtime items and rejects malformed JSON", async (t) => {
  const repository = await createTempRepository(t);
  let attempt = 0;
  const information = createInformationService({
    instructions: memoryInformationRules(),
    repository,
    retainMain: async () => undefined,
    runModel: async (input) => {
      attempt += 1;
      if (attempt === 1) return { ok: false, error: "MODEL_REQUEST_FAILED" };
      return {
        ok: true,
        result: {
          decisions: input.items.map((item) => ({ itemId: item.id, decision: "silent" as const, reason: "ok" })),
          notifications: [],
        },
      };
    },
  });
  await information.saveSettings({ enabled: true, batchWindowSeconds: 0 });
  await information.ingest([{ source: "sms", externalId: "retry-1", content: "hello" }]);
  const itemId = (await information.listItems({ limit: 1 })).items[0]!.id;

  const app = createInformationRoutes({ information } as unknown as HttpDependencies);
  const firstRun = await app.request("/runs", { method: "POST", body: "{}" });
  assert.equal(firstRun.status, 200);
  const firstBody = await firstRun.json() as { run: { status: string; model?: { status: string } } };
  assert.equal(firstBody.run.status, "failed");
  assert.equal(firstBody.run.model?.status, "failed");

  // Without retryFailed, failed items are skipped.
  const withoutRetry = await app.request("/runs", { method: "POST", body: "{}" });
  assert.equal(withoutRetry.status, 409);

  // With retryFailed: true (or empty body still skips, malformed JSON gives 400), failed items run.
  const badJson = await app.request("/runs", { method: "POST", body: "{broken" });
  assert.equal(badJson.status, 400);

  const retried = await app.request("/runs", {
    method: "POST",
    body: JSON.stringify({ retryFailed: true }),
  });
  assert.equal(retried.status, 200);
  const retriedBody = await retried.json() as { run: { status: string } };
  assert.equal(retriedBody.run.status, "completed");

  const detail = await information.getItem(itemId);
  assert.equal(detail?.item.status, "processed");
  assert.equal(detail?.item.decision, "silent");
  assert.equal(detail?.item.reason, "ok");
});
