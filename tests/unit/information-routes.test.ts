import assert from "node:assert/strict";
import test from "node:test";
import { createInformationRoutes } from "../../src/http/routes/information.js";
import { createInformationService } from "../../src/features/information/service.js";
import { defaultInformationState, type InformationRepository } from "../../src/features/information/types.js";
import type { HttpDependencies } from "../../src/bootstrap/types.js";

test("global preferences save main rules before retaining main for feedback", async () => {
  let state = { ...defaultInformationState(), preferences: { notes: "old", learnedNotes: "" } };
  const repository: InformationRepository = {
    read: async () => structuredClone(state),
    update: async (change) => {
      const changed = await change(structuredClone(state));
      if (changed.state) state = changed.state;
      return changed.result;
    },

    reconcileOnStart: async () => undefined,
    validateAll: async () => undefined,
  };
  let hubDepth = 0;
  let instructions = "";
  const order: string[] = [];
  const information = createInformationService({
    repository,

    retainMain: async () => {
      assert.equal(hubDepth, 0, "retainMain must run outside withExistingSession");
      order.push("retain");
      return {
        conversation: {
          piSessionId: () => "session-1",
          notify: async (_text, id) => ({ piSessionId: "session-1", messageId: id }),
        },
        release: () => order.push("release"),
      };
    },
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    readInstructions: async () => instructions,
    writeInstructions: async (text) => { instructions = text; },
    enabledSkillTexts: async () => [],
  });
  const dependencies = {
    conversationHub: {
      withExistingSession: async <T>(_sessionId: string, change: () => Promise<T>) => {
        hubDepth++;
        order.push("lock");
        try {
          return await change();
        } finally {
          hubDepth--;
        }
      },
    },
    information,
  } as unknown as HttpDependencies;
  const app = createInformationRoutes(dependencies);
  const response = await app.request("/preferences", {
    method: "PUT",
    body: JSON.stringify({ notes: "latest" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { notes: "latest", feedbackExamples: [] });
  assert.deepEqual(order, ["retain", "release"]);
});

test("POST runs returns the cancelled record when pause aborts while retain is pending", async (t) => {
  let state = defaultInformationState();
  const repository: InformationRepository = {
    read: async () => structuredClone(state),
    update: async (change) => {
      const changed = await change(structuredClone(state));
      if (changed.state) state = changed.state;
      return changed.result;
    },

    reconcileOnStart: async () => undefined,
    validateAll: async () => undefined,
  };
  let retainStarted = false;
  let releaseRetain!: () => void;
  let retainReleased = false;
  const retainGate = new Promise<void>((resolve) => { releaseRetain = resolve; });
  const information = createInformationService({
    repository,

    retainMain: async () => {
      retainStarted = true;
      await retainGate;
      return {
        conversation: {
          piSessionId: () => "session-1",
          notify: async (_text, id) => ({ piSessionId: "session-1", messageId: id }),
        },
        release: () => { retainReleased = true; },
      };
    },
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
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
  t.after(() => { releaseRetain(); });
  const deadline = Date.now() + 2000;
  while (!retainStarted && Date.now() < deadline && !t.signal.aborted) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(retainStarted,"global run route must actually retain main");
  const pause = information.pause();
  releaseRetain();

  const response = await responsePromise;
  assert.equal(response.status, 200);
  const body = await response.json() as { run: { status: string } };
  assert.equal(body.run.status, "cancelled");
  await pause.stopped;
  assert.equal(retainReleased, true);
  pause.resume();
});
