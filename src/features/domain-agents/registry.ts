import {
  DOMAIN_ID_PATTERN,
  type DomainAgentPromptSummary,
  type DomainAgentRegistration,
  type DomainQueryInput,
} from "./types.js";

export type DomainAgentErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND";

export class DomainAgentError extends Error {
  readonly code: DomainAgentErrorCode;

  constructor(code: DomainAgentErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "DomainAgentError";
  }
}

export type CreateDomainAgentRegistryOptions = {
  domains: readonly DomainAgentRegistration[];
};

/**
 * 轻量领域子 Agent 注册表：主 Agent 与各后台子 Agent 之间只通过
 * 「规则读取 + 按需只读查询」解耦，不共享聊天历史、也不依赖通用事件总线。
 */
export const createDomainAgentRegistry = (options: CreateDomainAgentRegistryOptions) => {
  const byId = new Map<string, DomainAgentRegistration>();
  for (const domain of options.domains) {
    if (!DOMAIN_ID_PATTERN.test(domain.id)) {
      throw new DomainAgentError("INVALID_INPUT", `Invalid domain ID: ${domain.id}`);
    }
    if (byId.has(domain.id)) {
      throw new DomainAgentError("INVALID_INPUT", `Duplicate domain ID: ${domain.id}`);
    }
    byId.set(domain.id, domain);
  }
  const ordered = [...byId.values()];

  const requireDomain = (rawDomainId: string): DomainAgentRegistration => {
    const domainId = typeof rawDomainId === "string" ? rawDomainId.trim() : "";
    if (!DOMAIN_ID_PATTERN.test(domainId)) {
      throw new DomainAgentError("INVALID_INPUT", "Invalid domain ID");
    }
    const domain = byId.get(domainId);
    if (!domain) {
      throw new DomainAgentError("NOT_FOUND", `Unknown domain agent: ${domainId}`);
    }
    return domain;
  };

  const describeForPrompt = (): DomainAgentPromptSummary[] =>
    ordered.map(({ id, name, summary }) => ({ id, name, summary }));

  const list = async () => {
    const domains = await Promise.all(
      ordered.map(async (domain) => ({
        id: domain.id,
        name: domain.name,
        summary: domain.summary,
        enabled: domain.isEnabled ? await domain.isEnabled() : true,
        capabilities: {
          rules: true as const,
          query: Boolean(domain.query),
        },
      })),
    );
    return { domains };
  };

  const getRules = async (domainId: string) => {
    const domain = requireDomain(domainId);
    const snapshot = await domain.rules.read();
    return {
      domainId: domain.id,
      name: domain.name,
      ...snapshot,
    };
  };

  const query = async (domainId: string, input: DomainQueryInput) => {
    const domain = requireDomain(domainId);
    if (!domain.query) {
      throw new DomainAgentError("INVALID_INPUT", `Domain ${domain.id} does not support query`);
    }
    const limit = input.limit === undefined ? undefined : Math.floor(input.limit);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      throw new DomainAgentError("INVALID_INPUT", "limit must be an integer from 1 to 100.");
    }
    const result = await domain.query({ ...input, ...(limit !== undefined ? { limit } : {}) });
    return {
      domainId: domain.id,
      name: domain.name,
      result,
    };
  };

  return {
    describeForPrompt,
    list,
    getRules,
    query,
  };
};

export type DomainAgentRegistry = ReturnType<typeof createDomainAgentRegistry>;
