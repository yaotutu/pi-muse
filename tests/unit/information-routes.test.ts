import assert from "node:assert/strict";
import test from "node:test";
import { createInformationRoutes } from "../../src/http/routes/information.js";
import { createInformationService } from "../../src/features/information/service.js";
import { defaultInformationState, type InformationRepository } from "../../src/features/information/types.js";
import type { HttpDependencies } from "../../src/bootstrap/types.js";

test("PUT preferences leaves the hub lock before retaining for feedback examples", async () => {
  let state = { ...defaultInformationState(), preferences: { notes: "old", learnedNotes: "" } };
  const repository: InformationRepository = {
    read: async () => structuredClone(state),
    update: async (_agentId, change) => {
      const changed = await change(structuredClone(state));
      if (changed.state) state = changed.state;
      return changed.result;
    },
    listAgentIds: async () => ["agent"],
    removeAgent: async () => undefined,
    reconcileOnStart: async () => undefined,
    validateAll: async () => undefined,
  };
  let hubDepth = 0;
  const order: string[] = [];
  const information = createInformationService({
    repository,
    agentExists: async () => true,
    retainAgent: async () => {
      assert.equal(hubDepth, 0, "retainAgent must run outside withExistingAgent");
      order.push("retain");
      return {
        conversation: {
          sessionId: () => "session-1",
          notify: async (_text, id) => ({ sessionId: "session-1", messageId: id }),
        },
        release: () => order.push("release"),
      };
    },
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  const dependencies = {
    conversationHub: {
      withExistingAgent: async <T>(_agentId: string, change: () => Promise<T>) => {
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
  const response = await app.request("/agent/information/preferences", {
    method: "PUT",
    body: JSON.stringify({ notes: "latest" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { notes: "latest", feedbackExamples: [] });
  assert.deepEqual(order, ["lock", "retain", "release"]);
});

test("POST runs returns the cancelled record when pause aborts while retain is pending", async () => {
  let state = defaultInformationState();
  const repository: InformationRepository = {
    read: async () => structuredClone(state),
    update: async (_agentId, change) => {
      const changed = await change(structuredClone(state));
      if (changed.state) state = changed.state;
      return changed.result;
    },
    listAgentIds: async () => ["agent"],
    removeAgent: async () => undefined,
    reconcileOnStart: async () => undefined,
    validateAll: async () => undefined,
  };
  let retainStarted = false;
  let releaseRetain!: () => void;
  let retainReleased = false;
  const retainGate = new Promise<void>((resolve) => { releaseRetain = resolve; });
  const information = createInformationService({
    repository,
    agentExists: async () => true,
    retainAgent: async () => {
      retainStarted = true;
      await retainGate;
      return {
        conversation: {
          sessionId: () => "session-1",
          notify: async (_text, id) => ({ sessionId: "session-1", messageId: id }),
        },
        release: () => { retainReleased = true; },
      };
    },
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
    readInstructions: async () => "",
    enabledSkillTexts: async () => [],
  });
  await information.saveSettings("agent", { enabled: true, batchWindowSeconds: 0 });
  await information.ingest("agent", [{ source: "rss", externalId: "1", content: "one" }]);

  const app = createInformationRoutes({
    conversationHub: {},
    information,
  } as unknown as HttpDependencies);
  const responsePromise = app.request("/agent/information/runs", {
    method: "POST",
    body: "{}",
  });
  while (!retainStarted) await new Promise((resolve) => setImmediate(resolve));
  const pause = information.pauseAgent("agent");
  releaseRetain();

  const response = await responsePromise;
  assert.equal(response.status, 200);
  const body = await response.json() as { run: { status: string } };
  assert.equal(body.run.status, "cancelled");
  await pause.stopped;
  assert.equal(retainReleased, true);
  pause.resume();
});
