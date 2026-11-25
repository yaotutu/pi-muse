import type { WorkspaceIncludeDiagnostic } from "../../shared/workspace-includes.js";
import type { HabitItem } from "../habits/types.js";

/** Subagent 唯一标识格式：小写字母开头，兼作聊天路由目标、通知归属与 HTTP 路径参数。 */
export const SUBAGENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** 领域显式指令上限，与 HTTP 偏好契约一致。 */
export const SUBAGENT_INSTRUCTIONS_MAX_LENGTH = 20_000;

export type SubagentTrigger = "chat" | "background";

export type SubagentPromptSection = {
  /** 提示词片段标识（如 chat / realtime / archive / briefing / screening / consolidate）。 */
  key: string;
  /** 面向展示的中文标题。 */
  label: string;
  /** 适用的触发模式。 */
  trigger: SubagentTrigger;
  /** 提示词来源：builtin=仓库内置静态提示词；workspace=用户可编辑工作区文档。 */
  source: "builtin" | "workspace";
  /** 相对路径或来源说明（如 prompts/subagents/sms-chat.md）。 */
  sourcePath: string;
  /** 是否可通过现有或未来 API 编辑。 */
  editable: boolean;
  /** 提示词原文。 */
  content: string;
};

export type SubagentToolSpec = {
  name: string;
  description: string;
  triggers: readonly SubagentTrigger[];
  requiresApproval?: boolean;
};

export type SubagentSkillSpec = {
  name: string;
  description: string;
};

export type SubagentMcpSpec = {
  name: string;
  description?: string;
  transport?: string;
};

export type SubagentExecutionPolicy = {
  /** 永远为 true：纯函数语义，无跨次聊天上下文，仅单次执行周期内拥有独立内存会话记录。 */
  stateless: true;
  /** 是否允许在 parallel 并发模式中运行（如 browser 独占共享 Chrome 为 false）。 */
  parallelAllowed: boolean;
};

export type SubagentInstructionsSnapshot = {
  path: string;
  instructions: string;
  includes?: WorkspaceIncludeDiagnostic[];
  habits: HabitItem[];
  unconsolidatedFeedbackCount?: number;
};

export type SubagentEditability = {
  systemPrompts: "readonly";
  userInstructions: "editable" | "none";
  tools: "readonly";
  skills: "readonly";
  mcp: "readonly";
};

export type SubagentSummary = {
  id: string;
  name: string;
  description: string;
  triggers: readonly SubagentTrigger[];
  enabled: boolean;
  executionPolicy: SubagentExecutionPolicy;
  hasUserInstructions: boolean;
  capabilities: {
    tools: readonly SubagentToolSpec[];
    skills: readonly SubagentSkillSpec[];
    mcp: readonly SubagentMcpSpec[];
  };
  editability: SubagentEditability;
};

export type SubagentDetail = SubagentSummary & {
  prompts: readonly SubagentPromptSection[];
  userInstructions: SubagentInstructionsSnapshot | null;
};

export type SubagentChatDescriptor = {
  id: string;
  name: string;
  description: string;
  parallelAllowed: boolean;
};

export type SubagentChatRunResult = {
  agent: string;
  task: string;
  output: string;
  isError?: boolean;
};

/**
 * 主聊天路由调用 Subagent 时透传的运行时上下文。
 * 只用于单次执行周期的取消、活动/状态观测与审批绑定，不传递父会话聊天历史。
 */
export type SubagentChatRunContext = {
  sessionId: string;
  runId?: string;
  subagentId: string;
  parentToolCallId?: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  /** 由 session-factory 绑定的版本校验人工审批写入器，仅在聊天路由态下提供。 */
  writeWorkspaceFile?: (
    path: string,
    content: string,
    toolCallId: string,
    signal: AbortSignal | undefined,
    toolContext: unknown,
  ) => Promise<{ isError?: boolean; text?: string }>;
  /** 可选的活动与状态观察器（由 adapter 侧按当前运行实例构造）。 */
  subscribers?: readonly unknown[];
};

export type SubagentRegistration = {
  id: string;
  name: string;
  description: string;
  triggers: readonly SubagentTrigger[];
  isEnabled?: () => Promise<boolean> | boolean;
  /** 仅当 triggers 包含 "chat" 时生效：控制是否向主聊天开放路由（默认 true，不因后台定时开关关闭而阻止聊天查库或改规则）。 */
  isChatAvailable?: () => Promise<boolean> | boolean;
  executionPolicy: SubagentExecutionPolicy;
  prompts: () => Promise<readonly SubagentPromptSection[]> | readonly SubagentPromptSection[];
  tools: readonly SubagentToolSpec[];
  skills: readonly SubagentSkillSpec[];
  mcp: readonly SubagentMcpSpec[];
  userInstructions?: {
    path: string;
    read: () => Promise<Omit<SubagentInstructionsSnapshot, "path">>;
  };
  /** 仅当 triggers 包含 "chat" 时提供：以纯函数方式在独立内存会话中执行主聊天路由任务。 */
  runChatTask?: (task: string, ctx: SubagentChatRunContext) => Promise<SubagentChatRunResult>;
};
