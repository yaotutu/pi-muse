import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExecutionBoundary } from "../../src/features/conversation/execution-boundary.ts";

const turn = (runId) => ({ runId, userId: `user-${runId}`, assistantId: `assistant-${runId}`, text: "hello" });
const records = (...runs) => ({
  turns: runs.map(([runId]) => turn(runId)),
  results: new Map(runs.filter(([, status]) => status).map(([runId, status]) => [runId, { runId, status }])),
});

for (const status of ["completed", "aborted", "failed"]) {
  test(`execution boundary after ${status} reflects the previous result`, () => {
    const boundary = buildExecutionBoundary(records(["old", status]), "current");
    if (status === "completed") assert.equal(boundary, undefined);
    else {
      assert.match(boundary, /^Execution boundary for this turn:/);
      assert.match(boundary, /stopped before completion/);
      assert.match(boundary, /tool results are historical facts only/);
      assert.match(boundary, /new message according to its own intent/);
      assert.match(boundary, /unless the new message explicitly asks/);
    }
  });
}

test("execution boundary ignores the current run even if it has a result", () => {
  assert.equal(buildExecutionBoundary(records(["current", "aborted"]), "current"), undefined);
});

test("execution boundary is absent without records", () => {
  assert.equal(buildExecutionBoundary(records(), "current"), undefined);
});

test("execution boundary uses the latest historical turn with a result", () => {
  assert.equal(buildExecutionBoundary(records(["older", "aborted"], ["latest", "completed"], ["current"]), "current"), undefined);
  assert.match(buildExecutionBoundary(records(["older", "completed"], ["latest", "failed"], ["unfinished"], ["current", "completed"]), "current"), /^Execution boundary/);
});
