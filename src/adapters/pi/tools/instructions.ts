import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { ASSISTANT_TEXT_LIMIT } from "../../../features/identity/types.js";
import { type DataLayout } from "../../storage/data-layout.js";
import { managedWorkspaceTexts } from "../../workspace/managed-text.js";
import { readAssistantInstructions } from "../../storage/assistant-instructions.js";

/**
 * 助手指令工具：按用户明确请求读取或更新全局助手指令（INSTRUCTIONS.md）。
 * 修改后在下一轮对话开始时自动注入 System Prompt 生效。
 */
export const instructionsTool = (
  layout: DataLayout,
  write?: ReturnType<typeof import("./files-writable.js").createWritableFileTools>[0]["execute"],
) =>
  defineTool({
    name: "instructions",
    label: "Assistant instructions",
    description:
      "Read or update the custom instructions/rules shared by all conversations. " +
      "Only update when the user explicitly asks you to follow specific guidelines, rules, tone, or workflows across all conversations. " +
      "Action 'get' returns current rules; 'set' replaces the rules with the provided content.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("get"), Type.Literal("set")]),
      content: Type.Optional(
        Type.String({ maxLength: ASSISTANT_TEXT_LIMIT, description: "Required for 'set': the complete instructions text to set across all conversations. Empty text explicitly clears the rules." }),
      ),
    }, { additionalProperties: false }),
    async execute(id, params, signal, onUpdate, context) {
      const file = layout.assistantInstructionsFile;
      if (params.action === "get") {
        const text = await readAssistantInstructions(file, layout.workspaceDir);
        return {
          content: [
            {
              type: "text",
              text: text ? `Current assistant instructions:\n\n${text}` : "No custom instructions set across all conversations.",
            },
          ],
          details: undefined,
        };
      }

      if (params.action === "set") {
        if (typeof params.content !== "string") return {
          content: [{ type: "text", text: "Set requires explicit content; use an empty string only to clear instructions." }],
          details: { denied: true }, isError: true,
        };
        const content = params.content;
        if (content.length > ASSISTANT_TEXT_LIMIT) return {
          content: [{ type: "text", text: `Instructions exceed maximum length (${ASSISTANT_TEXT_LIMIT})` }],
          details: { denied: true }, isError: true,
        };
        if (!write) return {
          content: [{ type: "text", text: "Instruction editing is unavailable." }],
          details: { denied: true }, isError: true,
        };
        return write(id, { path: managedWorkspaceTexts.instructions, content }, signal, onUpdate, context);
      }

      return {
        content: [{ type: "text", text: "Unknown action" }],
        details: undefined,
        isError: true,
      };
    },
  });
