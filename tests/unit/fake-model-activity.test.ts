import assert from "node:assert/strict";
import test from "node:test";
import { createFakeModel } from "../support/fake-model.js";
import { buildExecutionBoundary } from "../../src/features/conversation/execution-boundary.js";

for (const interrupted of [false, true]) {
  test(`activity provider fixture recognizes explicit script ${interrupted ? "after execution boundary" : "without a boundary"}`, async (t) => {
    const model = await createFakeModel();
    t.after(() => model.close());
    const args = { action: "resume", activityId: "fixture-activity" };
    const script = `E2E activity ${JSON.stringify({ calls: [{ name: "activity", args }], end: "reply" })}`;
    const boundary = interrupted ? buildExecutionBoundary({
      turns: [{ userId: "previous-user", text: "Previous task", runId: "previous-run", assistantId: "previous-assistant" }],
      results: new Map([["previous-run", { runId: "previous-run", status: "aborted" }]]),
    }, "current-run") : undefined;
    if (interrupted) assert.ok(boundary);
    const response = await fetch(model.baseUrl + "/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-model", stream: true, messages: [{ role: "user", content: boundary ? `${boundary}\n\n${script}` : script }] }),
    });
    assert.equal(response.status, 200);
    const frames = (await response.text()).split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const calls = frames.flatMap((frame) => frame.choices[0].delta.tool_calls ?? []);
    assert.equal(calls.length, 1, "a boundary must not turn the explicit activity script into ordinary chat");
    assert.equal(calls[0].function.name, "activity");
    assert.deepEqual(JSON.parse(calls[0].function.arguments), args);
  });
}
