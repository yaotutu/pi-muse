import type { WorkspaceIncludeDiagnostic } from "../../shared/workspace-includes.js";
import type { HabitItem } from "../habits/types.js";

/** 领域子 Agent 标识格式；稳定小写字母开头，兼作工具参数、通知归属与引用头标识。 */
export const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** 单领域显式指令上限，与 HTTP 偏好契约一致。 */
export const DOMAIN_INSTRUCTIONS_MAX_LENGTH = 20_000;

export type DomainInstructionsSnapshot = {
  instructions: string;
  includes?: WorkspaceIncludeDiagnostic[];
  habits: HabitItem[];
  unconsolidatedFeedbackCount?: number;
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
  instructions: {
    read: () => Promise<DomainInstructionsSnapshot>;
  };
  query?: (input: DomainQueryInput) => Promise<Record<string, unknown>>;
};
