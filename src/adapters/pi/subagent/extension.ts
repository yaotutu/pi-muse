import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionFactory, type AgentToolResult, type AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { SubagentChatDescriptor, SubagentChatRunResult } from "../../../features/subagents/types.js";

export const SUBAGENT_TOOL_NAME = "subagent";
export type SubagentMode = "single" | "parallel" | "chain";
export type SubagentResult = SubagentChatRunResult;
export type SubagentRunner = (
  agent: SubagentChatDescriptor,
  task: string,
  signal: AbortSignal | undefined,
  update: (result: SubagentResult) => void,
  parentToolCallId?: string,
  subagentId?: string,
  mode?: SubagentMode,
) => Promise<SubagentResult>;
type Details = { mode: SubagentMode; results: SubagentResult[]; denied?: boolean };

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const taskItem = Type.Object({
  agent: Type.String({ minLength: 1, description: "Subagent ID from available subagents." }),
  task: Type.String({ minLength: 1, description: "Self-contained instruction; child does not inherit parent conversation history." }),
}, { additionalProperties: false });

export const subagentParameters = Type.Object({
  mode: Type.Union([
    Type.Literal("single"),
    Type.Literal("parallel"),
    Type.Literal("chain"),
  ], {
    description: "Execution mode: single (exactly 1 task), parallel (1-8 concurrent tasks), or chain (1-8 sequential tasks where {previous} inserts prior step output).",
  }),
  tasks: Type.Array(taskItem, {
    minItems: 1,
    maxItems: MAX_PARALLEL_TASKS,
    description: "Subagent tasks to execute (1-8 tasks). Single mode requires exactly 1 task. When multiple tasks are provided, mode must be 'parallel' or 'chain'.",
  }),
}, { additionalProperties: false });

const truncateOutput = (output: string) => {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= PER_TASK_OUTPUT_CAP) return output;
  let end = PER_TASK_OUTPUT_CAP;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}\n\n[Output truncated]`;
};

export const createSubagentTool = (
  agents: readonly SubagentChatDescriptor[],
  run: SubagentRunner,
  queued?: (id: string, role: string) => void,
) => defineTool({
  name: SUBAGENT_TOOL_NAME,
  label: "Subagent",
  description: "Route self-contained specialized work to stateless subagents with isolated execution contexts. " +
    "Provide mode ('single' | 'parallel' | 'chain') and tasks array (1-8 tasks). " +
    "Single mode requires exactly 1 task; parallel runs tasks concurrently; chain runs tasks sequentially where {previous} inserts prior step output. " +
    "Results return to you in this tool call, not a background queue. " +
    `Available subagents: ${agents.map((agent) => `${agent.id} (${agent.name}): ${agent.description}`).join("; ")}`,
  parameters: subagentParameters,
  constrainedSampling: { type: "json_schema", strict: "prefer" },
  async execute(_id, params, signal, onUpdate): Promise<AgentToolResult<Details>> {
    const mode = params.mode;
    const reject = (text: string): AgentToolResult<Details> => ({
      content: [{ type: "text", text }],
      details: { mode, results: [], denied: true },
      isError: true,
    });
    if (mode === "single" && params.tasks.length !== 1) {
      return reject("Single mode requires exactly one task. For multiple tasks, set mode to 'chain' (sequential) or 'parallel' (concurrent).");
    }
    const missing = params.tasks.find((request) => !agents.some((agent) => agent.id === request.agent));
    if (missing) {
      return reject(`Unknown subagent. Available subagents: ${agents.map((agent) => agent.id).join(", ")}`);
    }
    if (mode === "parallel") {
      const nonParallel = params.tasks.find((request) => {
        const candidate = agents.find((agent) => agent.id === request.agent);
        return candidate && !candidate.parallelAllowed;
      });
      if (nonParallel) {
        return reject(`Subagent '${nonParallel.agent}' cannot run in parallel mode because it uses an exclusive resource. Use 'single' or 'chain' mode instead.`);
      }
    }

    const requests = params.tasks;
    const childIds = requests.map(() => `subagent-${randomUUID()}`);
    requests.forEach((request, index) => queued?.(childIds[index], request.agent));
    const results: SubagentResult[] = [];
    const update: AgentToolUpdateCallback<Details> | undefined = onUpdate;
    const emit = () => update?.({
      content: [{ type: "text", text: `Subagents: ${results.filter(Boolean).length}/${requests.length} finished` }],
      details: { mode, results: results.filter(Boolean).map((result) => ({ ...result, output: truncateOutput(result.output) })) },
    });
    const runOne = async (index: number, task: string) => {
      signal?.throwIfAborted();
      const agent = agents.find((candidate) => candidate.id === requests[index].agent)!;
      let result: SubagentResult;
      try {
        result = await run(agent, task, signal, () => {
          // 仅报告进度，不把未结束的子会话原始消息/诊断塞入父会话。
          update?.({ content: [{ type: "text", text: `Subagent ${agent.id} is working` }], details: { mode, results: results.filter(Boolean) } });
        }, _id, childIds[index], mode);
      } catch {
        signal?.throwIfAborted();
        result = { agent: agent.id, task, output: "Subagent execution failed", isError: true };
      }
      signal?.throwIfAborted();
      results[index] = { ...result, output: truncateOutput(result.output) };
      emit();
      return results[index];
    };
    if (mode === "parallel") {
      let nextIndex = 0;
      // 按输入顺序返回，最多四项同时运行；取消后不启动尚未开始的项。
      await Promise.allSettled(Array.from({ length: Math.min(MAX_CONCURRENCY, requests.length) }, async () => {
        while (nextIndex < requests.length) {
          const index = nextIndex++;
          await runOne(index, requests[index].task);
        }
      }));
      signal?.throwIfAborted();
      if (results.filter(Boolean).length !== requests.length) {
        return {
          content: [{ type: "text", text: "Subagent execution failed." }],
          details: { mode, results },
          isError: true,
        };
      }
    } else {
      let previous = "";
      for (let index = 0; index < requests.length; index++) {
        const task = mode === "chain" ? requests[index].task.replace(/\{previous\}/g, () => previous) : requests[index].task;
        const result = await runOne(index, task);
        if (result.isError) return {
          content: [{ type: "text", text: mode === "chain" ? `Chain stopped at step ${index + 1}: ${result.output}` : result.output }],
          details: { mode, results },
          isError: true,
        };
        previous = result.output;
      }
    }
    return {
      content: [{ type: "text", text: mode === "parallel"
        ? results.map((result) => `### [${result.agent}] ${result.isError ? "failed" : "completed"}\n\n${result.output}`).join("\n\n---\n\n")
        : results.at(-1)?.output || "(no output)" }],
      details: { mode, results },
      ...(results.some((result) => result.isError) ? { isError: true } : {}),
    };
  },
});

export const createSubagentExtension = (
  agents: readonly SubagentChatDescriptor[],
  run: SubagentRunner,
  queued?: (id: string, role: string) => void,
): ExtensionFactory =>
  (pi) => { pi.registerTool(createSubagentTool(agents, run, queued)); };
