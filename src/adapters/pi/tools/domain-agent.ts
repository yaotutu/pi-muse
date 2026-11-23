import { defineTool, type AgentToolResult, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { DomainAgentError, type DomainAgentRegistry } from "../../../features/domain-agents/registry.js";
import { DOMAIN_INSTRUCTIONS_MAX_LENGTH, type DomainQueryAction } from "../../../features/domain-agents/types.js";
import { InformationError } from "../../../features/information/errors.js";
import { NewsError } from "../../../features/news/errors.js";
import { loadPrompt } from "../../prompts/loader.js";

export const DOMAIN_AGENT_TOOL_NAME = "domain_agent";

export const DOMAIN_AGENT_TOOL_INSTRUCTIONS = loadPrompt("assistant/tools/domain-agent.md");

type DomainAgentToolResult = { error: string } | Record<string, unknown>;

const rejected = (text: string, extra?: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text }],
  details: { denied: true, ...extra },
  isError: true,
});

const QUERY_ACTIONS: ReadonlySet<DomainQueryAction> = new Set([
  "overview",
  "items",
  "item",
  "runs",
  "run",
]);

export const createDomainAgentTool = (
  registry: DomainAgentRegistry,
  context?: {
    readOnly?: boolean;
    writeInstructions?: (domainId: string, instructions: string, toolCallId: string, signal: AbortSignal | undefined, toolContext: ExtensionToolContext) => Promise<{ isError?: boolean }>;
  },
) =>
  defineTool({
    name: DOMAIN_AGENT_TOOL_NAME,
    label: "Domain Agent",
    description: DOMAIN_AGENT_TOOL_INSTRUCTIONS,
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("get_instructions"),
          Type.Literal("update_instructions"),
          Type.Literal("query"),
        ]),
        domain: Type.Optional(Type.String({ description: "Target domain ID such as sms or news." })),
        instructions: Type.Optional(Type.String({ description: "Complete merged explicit user instructions text for update_instructions." })),
        reason: Type.Optional(Type.String({ description: "Brief explanation for why the domain instructions are being updated." })),
        queryAction: Type.Optional(
          Type.Union([
            Type.Literal("overview"),
            Type.Literal("items"),
            Type.Literal("item"),
            Type.Literal("runs"),
            Type.Literal("run"),
          ]),
        ),
        status: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
        cursor: Type.Optional(Type.String()),
        itemId: Type.Optional(Type.String()),
        runId: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    execute: async (toolCallId, params, signal, _onUpdate, toolContext): Promise<AgentToolResult<DomainAgentToolResult>> => {
      try {
        if (params.action === "list") {
          const result = await registry.list();
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
          };
        }
        const domain = params.domain?.trim();
        if (!domain) {
          return rejected("domain is required for this action.");
        }
        if (params.action === "get_instructions") {
          const result = await registry.getInstructions(domain);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
          };
        }
        if (params.action === "update_instructions") {
          if (context?.readOnly) {
            return rejected("Subagent sessions cannot modify domain instructions; only read-only domain inspection is allowed.");
          }
          if (typeof params.instructions !== "string" || params.instructions.length > DOMAIN_INSTRUCTIONS_MAX_LENGTH) {
            return rejected(`instructions must be a string of at most ${DOMAIN_INSTRUCTIONS_MAX_LENGTH} characters`);
          }
          if (!context?.writeInstructions) return rejected("Approved instruction writing is unavailable.");
          signal?.throwIfAborted();
          const current = await registry.getInstructions(domain);
          signal?.throwIfAborted();
          if (current.instructions === params.instructions) {
            return { content: [{ type: "text", text: "Domain instructions are unchanged." }], details: { updated: false } };
          }
          const saved = await context.writeInstructions(current.domainId, params.instructions, toolCallId, signal, toolContext);
          if (saved.isError) return rejected("Instruction change did not report success. Check the file approval result before trying again.");
          const result = { domainId: current.domainId, name: current.name, instructions: params.instructions, updated: true };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
          };
        }
        const queryAction = params.queryAction ?? "overview";
        if (!QUERY_ACTIONS.has(queryAction)) {
          return rejected("Invalid queryAction.");
        }
        const result = await registry.query(domain, {
          action: queryAction,
          status: params.status,
          limit: params.limit,
          cursor: params.cursor,
          itemId: params.itemId,
          runId: params.runId,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      } catch (error) {
        if (error instanceof DomainAgentError) {
          return rejected(error.message, { code: error.code });
        }
        if (error instanceof InformationError && error.code !== "SHUTDOWN") {
          return rejected(error.message, { code: error.code });
        }
        if (error instanceof NewsError && error.code !== "SHUTDOWN") {
          return rejected(error.message, { code: error.code });
        }
        throw error;
      }
    },
  });
