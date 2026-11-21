import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { DomainAgentError, type DomainAgentRegistry } from "../../../features/domain-agents/registry.js";
import type { DomainQueryAction } from "../../../features/domain-agents/types.js";
import { InformationError } from "../../../features/information/errors.js";
import { NewsError } from "../../../features/news/errors.js";

export const DOMAIN_AGENT_TOOL_NAME = "domain_agent";

export const DOMAIN_AGENT_TOOL_INSTRUCTIONS = [
  "Inspect and configure Pi Muse's registered background domain agents (such as sms and news).",
  "Actions:",
  "- list: view all registered domain agents, whether each is enabled, ruleUpdateMode, and capabilities.",
  "- get_rules: read a domain's explicit rules (`notes`), learned sensitivity profile (`learnedNotes`), and feedback examples.",
  "- update_rules: update a domain's explicit rules (`notes`). Always call `get_rules` first, concisely merge new user rules without losing existing rules, and write rules here rather than storing domain rules only in global `memory`.",
  "- query: read-only inspection of domain items, articles, sources, or runs via `queryAction` (`overview` | `items` | `item` | `runs` | `run`).",
].join("\n");

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
  context?: { sessionId?: string; runId?: string; readOnly?: boolean },
) =>
  defineTool({
    name: DOMAIN_AGENT_TOOL_NAME,
    label: "Domain Agent",
    description: DOMAIN_AGENT_TOOL_INSTRUCTIONS,
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("get_rules"),
          Type.Literal("update_rules"),
          Type.Literal("query"),
        ]),
        domain: Type.Optional(Type.String({ description: "Target domain ID such as sms or news." })),
        notes: Type.Optional(Type.String({ description: "Complete merged explicit rules text for update_rules." })),
        reason: Type.Optional(Type.String({ description: "Brief explanation for why the domain rules are being updated." })),
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
    execute: async (_id, params, signal): Promise<AgentToolResult<DomainAgentToolResult>> => {
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
        if (params.action === "get_rules") {
          const result = await registry.getRules(domain);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
          };
        }
        if (params.action === "update_rules") {
          if (context?.readOnly) {
            return rejected("Subagent sessions cannot modify domain rules; only read-only domain inspection is allowed.");
          }
          if (typeof params.notes !== "string") {
            return rejected("notes is required for update_rules.");
          }
          const result = await registry.updateRules({
            domainId: domain,
            notes: params.notes,
            reason: params.reason,
            sessionId: context?.sessionId,
            runId: context?.runId,
            signal,
          });
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
