import { memoryInformationRules } from "../support/information-rules.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createInformationRoutes } from "../../src/http/routes/information.js";
import { createInformationService } from "../../src/features/information/service.js";
import { defaultInformationState, type InformationRepository } from "../../src/features/information/types.js";
import type { HttpDependencies } from "../../src/bootstrap/types.js";

test("global preferences save instructions cleanly without retaining main", async () => {
  let state = defaultInformationState();
  const repository: InformationRepository = {
    read: async () => structuredClone(state),
    update: async (change) => {
      const changed = await change(structuredClone(state));
      if (changed.state) state = changed.state;
      return changed.result;
    },
    nextRealtimeDue: async () => false,
    reconcileOnStart: async () => undefined,
    validateAll: async () => undefined,
  };
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
    habits: [],
    unconsolidatedFeedbackCount: 0,
    feedbackExamples: [],
  });
  assert.equal(retained, false);
});

test("POST runs returns the cancelled record when pause aborts while model is running", async (t) => {
  let state = defaultInformationState();
  const repository: InformationRepository = {
    read: async () => structuredClone(state),
    update: async (change) => {
      const changed = await change(structuredClone(state));
      if (changed.state) state = changed.state;
      return changed.result;
    },
    nextRealtimeDue: async () => false,
    reconcileOnStart: async () => undefined,
    validateAll: async () => undefined,
  };
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
