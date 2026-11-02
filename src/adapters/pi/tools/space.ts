import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { SpaceCommunicationError, type SpaceCaller, type SpaceCommunication } from "../../../features/space-communication/service.js";

export const SPACE_TOOL_INSTRUCTIONS = [
  "Use space to communicate with other project spaces, including news and SMS. All project spaces trust each other by default; no binding or allowlist is required.",
  "list discovers existing spaces and their IDs. request asks targetSpaceId to process message in its own isolated discussion and returns its actual reply.",
  "Pass only the necessary context, not the whole current chat. Reuse the returned discussionId and targetSpaceId for follow-up requests about the same matter; omit discussionId for a new matter.",
  "history reads a discussion by targetSpaceId and discussionId. Replies may ask the user for clarification: show the question and send their answer in the same discussion, never invent their choice.",
  "Notification bindings only control unsolicited delivery, never request permissions or reply destinations. Do not delegate back and forth without a concrete new subtask; do not claim success on failed/cancelled results.",
].join(" ");

export const createSpaceTool = (communication: Pick<SpaceCommunication, "listSpaces" | "request" | "history">, sourceSpaceId: string, caller?: SpaceCaller) => defineTool({
  name: "space", label: "Space communication", description: SPACE_TOOL_INSTRUCTIONS,
  parameters: Type.Object({
    action: StringEnum(["list", "request", "history"] as const),
    targetSpaceId: Type.Optional(Type.String({ description: "Existing workspace or feature space ID; discover with list." })),
    message: Type.Optional(Type.String({ minLength: 1, maxLength: 20000 })),
    discussionId: Type.Optional(Type.String({ description: "Returned discussion ID; keep it for follow-up interactions." })),
    context: Type.Optional(Type.String({ maxLength: 20000, description: "Only relevant user-authorized context or quoted content; no automatic copy of chat history." })),
  }, { additionalProperties: false }),
  execute: async (_id, input, signal): Promise<AgentToolResult<Record<string, unknown>>> => {
    try {
      let result: unknown;
      if (input.action === "list") result = await communication.listSpaces();
      else if (input.action === "history" && input.targetSpaceId && input.discussionId) result = await communication.history(input.targetSpaceId, input.discussionId);
      else if (input.action === "request" && input.targetSpaceId && input.message) result = await communication.request({ sourceSpaceId, targetSpaceId: input.targetSpaceId, message: input.message, discussionId: input.discussionId, context: input.context }, signal, caller);
      else throw new SpaceCommunicationError("INVALID_INPUT", "request requires targetSpaceId/message; history requires targetSpaceId/discussionId");
      const failed = result && typeof result === "object" && "status" in result && result.status !== "completed";
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { result, ...(failed ? { denied: true } : {}) }, ...(failed ? { isError: true } : {}) };
    } catch (error) {
      if (!(error instanceof SpaceCommunicationError)) throw error;
      return { content: [{ type: "text" as const, text: error.message }], details: { denied: true, code: error.code }, isError: true };
    }
  },
});
