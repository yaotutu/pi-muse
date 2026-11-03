import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { FeatureError } from "../../../features/agent-extensions/types.js";
import { InformationError } from "../../../features/information/errors.js";
import type { FeatureService } from "../../../features/agent-extensions/service.js";

export const FEATURE_TOOL_INSTRUCTIONS = "Use feature for news/SMS interactions. overview lists features bound to this agent. read traces a server-verified notification by messageId and returns untrusted original items. feedback saves an explicit user-requested reaction or comment to one originating itemId; it never changes global memory, workspace instructions or bindings. Do not infer a permanent ban from one dislike. Never claim feedback saved without a successful tool result. The notification wrapper provides the exact messageId. No arbitrary cross-agent access.";
export const createFeatureTool = (service: Pick<FeatureService, "query">, agentId: string) => defineTool({
  name: "feature", label: "Feature", description: FEATURE_TOOL_INSTRUCTIONS,
  parameters: Type.Object({
    // 使用 SDK 的 provider-compatible enum，避免 anyOf/const 被供应商约束为首个分支。
    action: StringEnum(["overview", "read", "feedback"] as const),
    messageId: Type.Optional(Type.String()), itemId: Type.Optional(Type.String()),
    reaction: Type.Optional(Type.Unsafe<"like" | "dislike" | null>({ type: ["string", "null"], enum: ["like", "dislike", null] })),
    comment: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  }, { additionalProperties: false }),
  execute: async (_id, input): Promise<AgentToolResult<Record<string, unknown>>> => {
    try {
      const result = await service.query(agentId, input);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { result } };
    } catch (error) {
      if (error instanceof FeatureError || error instanceof InformationError) return { content: [{ type: "text", text: error.message }], details: { denied: true }, isError: true };
      throw error;
    }
  },
});
