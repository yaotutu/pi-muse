import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { AgentCommunicationError, type AgentCaller, type AgentCommunication } from "../../../features/agent-communication/service.js";

export const AGENT_TOOL_INSTRUCTIONS = [
  "Use agent to communicate with other project agents, including news and SMS. All project agents trust each other by default; no binding or allowlist is required.",
  "list discovers existing agents and their IDs. request asks targetAgentId to process message in its own isolated discussion and returns its actual reply.",
  "Pass only the necessary context, not the whole current chat. Reuse the returned discussionId and targetAgentId for follow-up requests about the same matter; omit discussionId for a new matter.",
  "history reads a discussion by targetAgentId and discussionId. Replies may ask the user for clarification: show the question and send their answer in the same discussion, never invent their choice.",
  "Notification bindings only control unsolicited delivery, never request permissions or reply destinations. Do not delegate back and forth without a concrete new subtask; do not claim success on failed/cancelled results.",
].join(" ");

export const createAgentTool = (communication: Pick<AgentCommunication, "listAgents" | "request" | "history">, sourceAgentId: string, caller?: AgentCaller) => defineTool({
  name: "agent", label: "Agent communication", description: AGENT_TOOL_INSTRUCTIONS,
  parameters: Type.Object({
    action: StringEnum(["list", "request", "history"] as const),
    targetAgentId: Type.Optional(Type.String({ description: "Existing workspace or feature agent ID; discover with list." })),
    message: Type.Optional(Type.String({ minLength: 1, maxLength: 20000 })),
    discussionId: Type.Optional(Type.String({ description: "Returned discussion ID; keep it for follow-up interactions." })),
    context: Type.Optional(Type.String({ maxLength: 20000, description: "Only relevant user-authorized context or quoted content; no automatic copy of chat history." })),
  }, { additionalProperties: false }),
  execute: async (_id, input, signal): Promise<AgentToolResult<Record<string, unknown>>> => {
    try {
      let result: unknown;
      if (input.action === "list") result = await communication.listAgents();
      else if (input.action === "history" && input.targetAgentId && input.discussionId) result = await communication.history(input.targetAgentId, input.discussionId);
      else if (input.action === "request" && input.targetAgentId && input.message) result = await communication.request({ sourceAgentId, targetAgentId: input.targetAgentId, message: input.message, discussionId: input.discussionId, context: input.context }, signal, caller);
      else throw new AgentCommunicationError("INVALID_INPUT", "request requires targetAgentId/message; history requires targetAgentId/discussionId");
      const failed = result && typeof result === "object" && "status" in result && result.status !== "completed";
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { result, ...(failed ? { denied: true } : {}) }, ...(failed ? { isError: true } : {}) };
    } catch (error) {
      if (!(error instanceof AgentCommunicationError)) throw error;
      return { content: [{ type: "text" as const, text: error.message }], details: { denied: true, code: error.code }, isError: true };
    }
  },
});
