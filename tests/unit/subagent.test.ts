import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { makeStrictJsonSchema, resolveJsonSchemaStrictSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import { createSubagentTool } from "../../src/adapters/pi/subagent/extension.js";
import type { SubagentChatDescriptor } from "../../src/features/subagents/types.js";
import { projectExecutionEvent } from "../../src/adapters/pi/execution.js";

const agents: SubagentChatDescriptor[] = [
  { id: "sms", name: "短信助手", description: "SMS subagent", parallelAllowed: true },
  { id: "demo", name: "演示助手", description: "Demo subagent", parallelAllowed: true },
  { id: "browser", name: "浏览器助手", description: "Browser subagent", parallelAllowed: false },
];
const context = undefined as never;

test("SDK validateToolArguments strictly validates subagent tool arguments against schema", () => {
  const tool = createSubagentTool(agents, async (agent, task) => ({ agent: agent.id, task, output: task }));
  const call = (args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id: "test-call", name: "subagent", arguments: args });

  assert.doesNotThrow(() => validateToolArguments(tool, call({ mode: "single", tasks: [{ agent: "sms", task: "hello" }] })));
  assert.doesNotThrow(() => validateToolArguments(tool, call({ mode: "parallel", tasks: [{ agent: "sms", task: "a" }, { agent: "demo", task: "b" }] })));
  assert.doesNotThrow(() => validateToolArguments(tool, call({ mode: "chain", tasks: [{ agent: "sms", task: "a" }, { agent: "demo", task: "b" }] })));

  assert.throws(() => validateToolArguments(tool, call({ tasks: [{ agent: "sms", task: "a" }] })));
  assert.throws(() => validateToolArguments(tool, call({ mode: "single" })));
  assert.throws(() => validateToolArguments(tool, call({ mode: "concurrent", tasks: [{ agent: "sms", task: "a" }] })));
  assert.throws(() => validateToolArguments(tool, call({ mode: "single", tasks: [] })));
  assert.throws(() => validateToolArguments(tool, call({ mode: "parallel", tasks: Array.from({ length: 9 }, () => ({ agent: "sms", task: "a" })) })));
  assert.throws(() => validateToolArguments(tool, call({ mode: "single", tasks: [{ agent: "", task: "a" }] })));
  assert.throws(() => validateToolArguments(tool, call({ mode: "single", tasks: [{ agent: "sms", task: "" }] })));
  assert.throws(() => validateToolArguments(tool, call({ agent: "sms", task: "a" })));
  assert.throws(() => validateToolArguments(tool, call({ chain: [{ agent: "sms", task: "a" }] })));
  assert.throws(() => validateToolArguments(tool, call({ mode: "single", tasks: [{ agent: "sms", task: "a" }], extra: true })));
});

test("subagent schema adapts to strict JSON schema constrained sampling", () => {
  const tool = createSubagentTool(agents, async (agent, task) => ({ agent: agent.id, task, output: task }));

  const strictSchema = makeStrictJsonSchema(tool.parameters);
  assert.equal(strictSchema.type, "object");
  assert.deepEqual(strictSchema.required, ["mode", "tasks"]);
  assert.equal(strictSchema.additionalProperties, false);

  const supportsStrict = resolveJsonSchemaStrictSampling(tool, true);
  assert.equal(supportsStrict, true);
});

test("subagent rejects single with multiple tasks, unknown agents, and non-parallel exclusive agents before executing", async () => {
  let runs = 0;
  let queuedCount = 0;
  const tool = createSubagentTool(
    agents,
    async (agent, task) => { runs++; return { agent: agent.id, task, output: task }; },
    () => { queuedCount++; },
  );

  const singleMulti = await tool.execute(
    "c-1",
    { mode: "single", tasks: [{ agent: "sms", task: "SECRET_TASK_1" }, { agent: "demo", task: "SECRET_TASK_2" }] },
    undefined, undefined, context,
  );
  assert.equal(singleMulti.isError, true);
  assert.equal(singleMulti.details?.denied, true);
  assert.equal(runs, 0);
  assert.equal(queuedCount, 0);
  const singleText = singleMulti.content[0].type === "text" ? singleMulti.content[0].text : "";
  assert.equal(singleText, "Single mode requires exactly one task. For multiple tasks, set mode to 'chain' (sequential) or 'parallel' (concurrent).");
  assert.ok(!singleText.includes("SECRET_TASK"));

  const unknownAgent = await tool.execute(
    "c-2",
    { mode: "single", tasks: [{ agent: "SECRET_UNKNOWN_AGENT", task: "SECRET_TASK_BODY" }] },
    undefined, undefined, context,
  );
  assert.equal(unknownAgent.isError, true);
  assert.equal(unknownAgent.details?.denied, true);
  assert.equal(runs, 0);
  const unknownText = unknownAgent.content[0].type === "text" ? unknownAgent.content[0].text : "";
  assert.ok(unknownText.startsWith("Unknown subagent. Available subagents: "));
  assert.ok(!unknownText.includes("SECRET_UNKNOWN_AGENT"));
  assert.ok(!unknownText.includes("SECRET_TASK_BODY"));

  const parallelBrowser = await tool.execute(
    "c-3",
    { mode: "parallel", tasks: [{ agent: "browser", task: "open page" }, { agent: "sms", task: "check sms" }] },
    undefined, undefined, context,
  );
  assert.equal(parallelBrowser.isError, true);
  assert.equal(parallelBrowser.details?.denied, true);
  assert.equal(runs, 0);
  const parallelText = parallelBrowser.content[0].type === "text" ? parallelBrowser.content[0].text : "";
  assert.match(parallelText, /cannot run in parallel mode/);
});

test("subagent execution failure is scrubbed and does not carry denied flag", async () => {
  const tool = createSubagentTool(agents, async () => {
    throw new Error("SECRET_INTERNAL_DATABASE_CRASH");
  });

  const failedResult = await tool.execute(
    "c-exec",
    { mode: "single", tasks: [{ agent: "sms", task: "normal work" }] },
    undefined, undefined, context,
  );
  assert.equal(failedResult.isError, true);
  assert.equal(failedResult.details?.denied, undefined);

  const projected = projectExecutionEvent({
    type: "tool_execution_end",
    toolCallId: "c-exec",
    toolName: "subagent",
    result: failedResult,
    isError: true,
  });
  assert.equal(projected?.type, "tool_result");
  if (projected?.type === "tool_result") {
    assert.equal(projected.content, "Tool execution failed");
  }
});

test("subagent protocol preserves single, chain {previous} substitution, parallel concurrency cap, and 50 KiB truncation", async () => {
  const calls: string[] = [];
  const tool = createSubagentTool(agents, async (agent, task) => {
    calls.push(task);
    return { agent: agent.id, task, output: task === "first" ? "literal $& value" : task, isError: task === "fail" };
  });
  const single = await tool.execute("one", { mode: "single", tasks: [{ agent: "sms", task: "single" }] }, undefined, undefined, context);
  assert.equal(single.content[0].type === "text" && single.content[0].text, "single");

  const chain = await tool.execute("chain", { mode: "chain", tasks: [{ agent: "sms", task: "first" }, { agent: "demo", task: "next {previous}" }] }, undefined, undefined, context);
  assert.equal(chain.content[0].type === "text" && chain.content[0].text, "next literal $& value");

  const failedChain = await tool.execute("chain-fail", { mode: "chain", tasks: [{ agent: "sms", task: "fail" }, { agent: "demo", task: "never" }] }, undefined, undefined, context);
  assert.equal(failedChain.isError, true);
  assert.ok(!calls.includes("never"));

  let active = 0;
  let peak = 0;
  const parallelTool = createSubagentTool(agents, async (agent, task) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    return { agent: agent.id, task, output: task === "big" ? "x".repeat(60 * 1024) : `ok:${task}` };
  });
  const parallel = await parallelTool.execute(
    "par",
    {
      mode: "parallel",
      tasks: [
        { agent: "sms", task: "big" },
        { agent: "demo", task: "2" },
        { agent: "sms", task: "3" },
        { agent: "demo", task: "4" },
        { agent: "sms", task: "5" },
      ],
    },
    undefined, undefined, context,
  );
  assert.equal(peak <= 4, true);
  assert.equal(parallel.details.results.length, 5);
  assert.match(parallel.details.results[0].output, /\[Output truncated\]$/);
});
