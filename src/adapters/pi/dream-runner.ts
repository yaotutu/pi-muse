import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { parseProposal, type ProposedChange } from "../../features/dream/proposal.js";
import type { DreamProposeResult } from "../../features/dream/service.js";
import { loadPrompt } from "../prompts/loader.js";
import { runSubagent, type SubagentRuntimeDeps } from "./subagent-runner.js";

export const PROPOSE_NOTES_TOOL_NAME = "propose_notes";

const targetLiteral = Type.Union([
  Type.Literal("user"),
  Type.Literal("soul"),
  Type.Literal("instructions"),
  Type.Literal("memory"),
  Type.Literal("pending"),
]);

const suggestedLiteral = Type.Union([
  Type.Literal("user"),
  Type.Literal("soul"),
  Type.Literal("instructions"),
  Type.Literal("memory"),
]);

/**
 * Dream 受限整理轮唯一可用的工具：只能提交结构化笔记建议，不能传入文件路径。
 * 每次调用通过 parseProposal 严格校验，通过后记录在当前整理轮内存中。
 */
export const createProposeNotesTool = (
  onAccepted: (changes: ProposedChange[]) => void,
  onInvalid: () => void,
) =>
  defineTool({
    name: PROPOSE_NOTES_TOOL_NAME,
    label: "Propose consolidated notes",
    description:
      "Submit structured note changes for USER, SOUL, INSTRUCTIONS, MEMORY or pending review. " +
      "USER, SOUL, and MEMORY are global; INSTRUCTIONS is only for this agent's purpose. " +
      "Use pending for a new note with uncertain cross-agent scope. Omit an uncertain " +
      "existing-memory edit/delete instead of converting it to pending or adding a replacement. " +
      "Call this at most once per turn with all proposed changes; pass an empty array if no changes are needed.",
    parameters: Type.Object(
      {
        changes: Type.Array(
          Type.Object(
            {
              target: targetLiteral,
              op: Type.Optional(
                Type.Union([
                  Type.Literal("add"),
                  Type.Literal("edit"),
                  Type.Literal("delete"),
                ]),
              ),
              id: Type.Optional(Type.String({ description: "Existing memory item id for edit/delete." })),
              suggestedTarget: Type.Optional(suggestedLiteral),
              text: Type.Optional(Type.String({ description: "Concise note text to save." })),
              source: Type.String({ description: "Message id from New messages that justifies this change." }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params) => {
      const parsed = parseProposal(params);
      if (!parsed) {
        onInvalid();
        return {
          content: [{ type: "text", text: "Invalid proposal schema." }],
          details: { denied: true },
          isError: true,
        };
      }
      onAccepted(parsed);
      return {
        content: [{ type: "text", text: `Accepted ${parsed.length} proposed change(s).` }],
        details: undefined,
      };
    },
  });

/**
 * Dream 整理轮：直接复用唯一通用 runSubagent 内核，
 * 只传结构化 propose_notes 工具与仓库内置提示词，不授予自由工具或聊天技能。
 */
export const createDreamProposer =
  (deps: SubagentRuntimeDeps) =>
  async (input: {
    sessionId: string;
    userPrompt: string;
    signal?: AbortSignal;
  }): Promise<DreamProposeResult> => {
    const systemPrompt = `${loadPrompt("dream/consolidate.md")}\n\n${loadPrompt("dream/hard-rules.md")}`;
    const collected: ProposedChange[] = [];
    let invalidCall = false;
    const tool = createProposeNotesTool(
      (changes) => {
        collected.push(...changes);
      },
      () => {
        invalidCall = true;
      },
    );

    const run = await runSubagent(deps, {
      cwd: deps.layout.agentDir,
      systemPrompt,
      prompt: input.userPrompt,
      tools: [tool],
      timeoutMs: null,
      signal: input.signal,
      trace: { sessionId: input.sessionId, kind: "dream" },
      onEvent: (event) => {
        if (event.type === "tool_execution_end" && event.isError) {
          invalidCall = true;
        }
      },
    });

    if (!run.ok) {
      if (run.error === "MODEL_NOT_CONFIGURED") {
        return { ok: false, error: "Model is not configured" };
      }
      return { ok: false, error: "Consolidation model request failed or was cancelled" };
    }
    if (invalidCall && !collected.length) {
      return { ok: false, error: "Model produced an invalid proposal" };
    }
    return { ok: true, changes: collected };
  };
