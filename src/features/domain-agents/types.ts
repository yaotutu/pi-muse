/** 领域子 Agent 标识格式；稳定小写字母开头，兼作工具参数、通知归属与引用头标识。 */
export const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** 单领域显式规则上限，与 HTTP 偏好契约一致。 */
export const DOMAIN_RULES_MAX_LENGTH = 20_000;

export type DomainRulesSnapshot = {
  notes: string;
  learnedNotes: string;
  feedbackExamples?: unknown[];
};

export type DomainQueryAction = "overview" | "items" | "item" | "runs" | "run";

export type DomainQueryInput = {
  action: DomainQueryAction;
  status?: string;
  limit?: number;
  cursor?: string;
  itemId?: string;
  runId?: string;
};

export type DomainAgentPromptSummary = {
  id: string;
  name: string;
  summary: string;
};

export type DomainAgentRegistration = {
  id: string;
  name: string;
  summary: string;
  isEnabled?: () => Promise<boolean>;
  rules: {
    read: () => Promise<DomainRulesSnapshot>;
  };
  query?: (input: DomainQueryInput) => Promise<Record<string, unknown>>;
};
