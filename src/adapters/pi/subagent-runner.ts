import { mkdir } from "node:fs/promises";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ModelRuntime,
  type ResourceLoader,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "../../config/load-config.js";
import type { ExecutionEvent } from "../../features/conversation/types.js";
import { runWithModelTrace, type ModelTraceContext } from "../model-trace/context.js";
import type { DataLayout } from "../storage/data-layout.js";
import { projectExecutionEvent } from "./execution.js";
import { createResourceLoader } from "./resource-loader.js";
import { SUBAGENT_TOOL_NAME } from "./subagent/extension.js";

/** 子代理硬禁止的工具集合：永不下放 bash 与递归 subagent。 */
export const SUBAGENT_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  SUBAGENT_TOOL_NAME,
]);

export type SubagentRuntimeDeps = {
  config: Config;
  layout: DataLayout;
  modelRuntime: ModelRuntime;
};

export type SubagentSpec = {
  cwd?: string;
  systemPrompt: string;
  prompt: string;
  /** 默认零工具（deny-by-default）；调用方显式声明才授予。 */
  tools?: readonly ToolDefinition[];
  /** 显式覆盖传给 SDK 的 tools allowlist（含已加载扩展工具名）；缺省取 tools[].name。 */
  allowedToolNames?: readonly string[];
  skills?: Skill[];
  extensions?: ReturnType<ResourceLoader["getExtensions"]>;
  compaction?: boolean;
  /** undefined 使用 config.runTimeoutMs；传 null 仅依赖外部 signal 取消。 */
  timeoutMs?: number | null;
  signal?: AbortSignal;
  trace: ModelTraceContext;
  onEvent?: (event: AgentSessionEvent, projected: ExecutionEvent | undefined) => void;
  subscribers?: readonly ((event: AgentSessionEvent) => void)[];
};

export type SubagentRunOutcome =
  | {
      ok: true;
      text: string;
      stopReason: string;
      toolAttempts: number;
      hadToolError: boolean;
    }
  | {
      ok: false;
      error: "MODEL_NOT_CONFIGURED" | "CANCELLED" | "TIMEOUT" | "MODEL_REQUEST_FAILED" | "MODEL_CONTENT_REJECTED";
      text: string;
      stopReason?: string;
      toolAttempts: number;
      hadToolError: boolean;
    };

/**
 * 上游供应商内容安全/审核拒绝（如 MiniMax 422 input new_sensitive、Azure content_filter、
 * Qwen DataInspectionFailed、智谱 content_exists_risk、Anthropic sensitive）属于对具体输入
 * 内容的确定性拒绝，与全局故障（401/429/5xx/超时/网络）严格区分，供上层隔离单条毒丸条目。
 * 原始错误文本只在本函数内部判定，绝不外泄或持久化。
 */
const NON_CONTENT_ERROR_PATTERN =
  /\b(invalid_api_key|authentication|unauthorized|forbidden|rate_limit|too many requests|quota|billing|insufficient_quota|context_length_exceeded|maximum context length|token limit|timeout|timed out|econnrefused|enotfound|etimedout|socket hang up|502|503|504)\b/i;

const CONTENT_REJECTED_ERROR_PATTERN =
  /(new_sensitive|\binput\b[^\n]{0,40}\bsensitive\b|\boutput\b[^\n]{0,40}\bsensitive\b|\bsensitive\s*\(\d+\)|provider stopped with:\s*sensitive|content_filter|content_management_policy|content_policy_violation|content filtering policy|safety_system|safety_block|datainspectionfailed|inappropriate content|content_exists_risk|risk_content|input_audit_failed|prohibited_content|blocklist|moderation_blocked|refused to complete the request)/i;

export const isContentRejectedError = (rawError: string | undefined): boolean => {
  if (!rawError) return false;
  if (NON_CONTENT_ERROR_PATTERN.test(rawError)) return false;
  return CONTENT_REJECTED_ERROR_PATTERN.test(rawError);
};

const assertAllowedTools = (spec: SubagentSpec): void => {
  for (const tool of spec.tools ?? []) {
    if (SUBAGENT_FORBIDDEN_TOOLS.has(tool.name)) {
      throw new Error(`Subagent cannot be granted forbidden tool: ${tool.name}`);
    }
  }
  for (const name of spec.allowedToolNames ?? []) {
    if (SUBAGENT_FORBIDDEN_TOOLS.has(name)) {
      throw new Error(`Subagent cannot be granted forbidden tool: ${name}`);
    }
  }
  for (const extension of spec.extensions?.extensions ?? []) {
    if (!(extension.tools instanceof Map)) continue;
    for (const name of extension.tools.keys()) {
      if (SUBAGENT_FORBIDDEN_TOOLS.has(name)) {
        throw new Error(`Subagent cannot be granted forbidden tool: ${name}`);
      }
    }
  }
};

/**
 * 唯一通用内存子代理内核（Deny-by-default）：
 * - 干净独立内存上下文，不写入会话 JSONL，不发现个人 CLI 资源；
 * - 默认零工具、零技能、零扩展，硬拦截 bash 与递归 subagent；
 * - 统一管理超时、AbortSignal 取消、错误脱敏、modelTrace 与安全 dispose。
 */
export const runSubagent = async (
  deps: SubagentRuntimeDeps,
  spec: SubagentSpec,
): Promise<SubagentRunOutcome> => {
  assertAllowedTools(spec);

  if (!deps.config.configured || !deps.config.modelId) {
    return {
      ok: false,
      error: "MODEL_NOT_CONFIGURED",
      text: "",
      toolAttempts: 0,
      hadToolError: false,
    };
  }
  const model = deps.modelRuntime.getModel("personal", deps.config.modelId);
  if (!model) {
    return {
      ok: false,
      error: "MODEL_NOT_CONFIGURED",
      text: "",
      toolAttempts: 0,
      hadToolError: false,
    };
  }
  if (spec.signal?.aborted) {
    return {
      ok: false,
      error: "CANCELLED",
      text: "",
      toolAttempts: 0,
      hadToolError: false,
    };
  }

  const cwd = spec.cwd ?? deps.layout.workspaceDir;
  const customTools = [...(spec.tools ?? [])];
  const allowedTools = [...(spec.allowedToolNames ?? customTools.map((tool) => tool.name))];

  await mkdir(deps.layout.agentDir, { recursive: true, mode: 0o700 });
  type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
  let session: PiSession | undefined;
  const abortSession = () => {
    void session?.abort().catch(() => undefined);
  };
  spec.signal?.addEventListener("abort", abortSession, { once: true });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let text = "";
  let stopReason: string | undefined;
  let toolAttempts = 0;
  let hadToolError = false;
  let rawErrorMessage: string | undefined;
  const unsubscribes: Array<() => void> = [];

  try {
    spec.signal?.throwIfAborted();
    session = (
      await createAgentSession({
        cwd,
        agentDir: deps.layout.agentDir,
        modelRuntime: deps.modelRuntime,
        model,
        sessionManager: SessionManager.inMemory(cwd),
        resourceLoader: createResourceLoader(
          spec.systemPrompt,
          spec.skills ?? [],
          spec.extensions,
        ),
        thinkingLevel: "off",
        customTools,
        tools: allowedTools,
        settingsManager: SettingsManager.inMemory({
          compaction: spec.compaction
            ? {
                enabled: true,
                reserveTokens: Math.min(16384, Math.floor(deps.config.contextWindow / 2)),
                keepRecentTokens: Math.min(20000, Math.floor(deps.config.contextWindow / 4)),
              }
            : { enabled: false },
          retry: { enabled: false },
        }),
      })
    ).session;

    const effectiveTimeout =
      spec.timeoutMs === undefined ? deps.config.runTimeoutMs : spec.timeoutMs;
    if (effectiveTimeout !== null) {
      timeout = setTimeout(() => {
        timedOut = true;
        abortSession();
      }, effectiveTimeout);
      timeout.unref();
    }

    // 核心监听最先挂载：确保 tool_execution_end 脱敏早于外部观察器。
    unsubscribes.push(
      session.subscribe((event) => {
        // 上游错误文本在 projectExecutionEvent 脱敏前捕获，仅用于内容审核分类，绝不外泄。
        if (event.type === "message_end" && event.message.role === "assistant" && event.message.errorMessage) {
          rawErrorMessage = event.message.errorMessage;
        }
        if (event.type === "tool_execution_start") toolAttempts++;
        if (event.type === "tool_execution_end" && event.isError) hadToolError = true;
        const projected = projectExecutionEvent(event);
        if (projected?.type === "assistant_end") {
          stopReason = projected.reason;
          if (projected.text) text = projected.text;
        }
        spec.onEvent?.(event, projected);
      }),
    );
    for (const subscriber of spec.subscribers ?? []) {
      unsubscribes.push(session.subscribe(subscriber));
    }

    await runWithModelTrace(spec.trace, async () => {
      spec.signal?.throwIfAborted();
      await session!.prompt(spec.prompt, { expandPromptTemplates: false });
      await session!.waitForIdle();
    });

    if (spec.signal?.aborted) {
      return { ok: false, error: "CANCELLED", text, stopReason, toolAttempts, hadToolError };
    }
    if (timedOut) {
      return { ok: false, error: "TIMEOUT", text, stopReason, toolAttempts, hadToolError };
    }
    if (!stopReason || stopReason === "error" || stopReason === "aborted") {
      return {
        ok: false,
        error:
          stopReason === "aborted"
            ? "CANCELLED"
            : isContentRejectedError(rawErrorMessage)
              ? "MODEL_CONTENT_REJECTED"
              : "MODEL_REQUEST_FAILED",
        text,
        stopReason,
        toolAttempts,
        hadToolError,
      };
    }
    return { ok: true, text, stopReason, toolAttempts, hadToolError };
  } catch (error) {
    await session?.abort().catch(() => undefined);
    await session?.waitForIdle().catch(() => undefined);
    const caughtErrorMessage = error instanceof Error ? error.message : String(error ?? "");
    return {
      ok: false,
      error: spec.signal?.aborted
        ? "CANCELLED"
        : timedOut
          ? "TIMEOUT"
          : isContentRejectedError(rawErrorMessage ?? caughtErrorMessage)
            ? "MODEL_CONTENT_REJECTED"
            : "MODEL_REQUEST_FAILED",
      text,
      stopReason,
      toolAttempts,
      hadToolError,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    spec.signal?.removeEventListener("abort", abortSession);
    for (const unsubscribe of unsubscribes) unsubscribe();
    session?.dispose();
  }
};

export type StructuredSubagentSpec<TSubmitted> = {
  cwd?: string;
  systemPrompt: string;
  prompt: string;
  extraTools?: readonly ToolDefinition[];
  buildSubmitTool: (onSubmitted: (value: TSubmitted) => void) => ToolDefinition;
  validateSubmitted: (value: TSubmitted) => void;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  trace: ModelTraceContext;
};

export type StructuredSubagentOutcome<TSubmitted> =
  | { ok: true; value: TSubmitted }
  | { ok: false; error: "MODEL_REQUEST_FAILED" | "MODEL_CONTENT_REJECTED" | "INVALID_MODEL_RESULT" | "CANCELLED" };

/** 结构化子代理薄组合封装：复用同一 runSubagent 内核并校验恰好一次合法提交。 */
export const runStructuredSubagent = async <TSubmitted>(
  deps: SubagentRuntimeDeps,
  spec: StructuredSubagentSpec<TSubmitted>,
): Promise<StructuredSubagentOutcome<TSubmitted>> => {
  let submitted: TSubmitted | undefined;
  let validSubmissions = 0;
  let submitAttempts = 0;
  const submitTool = spec.buildSubmitTool((value) => {
    validSubmissions++;
    submitted ??= value;
  });

  const run = await runSubagent(deps, {
    cwd: spec.cwd,
    systemPrompt: spec.systemPrompt,
    prompt: spec.prompt,
    tools: [...(spec.extraTools ?? []), submitTool],
    timeoutMs: spec.timeoutMs,
    signal: spec.signal,
    trace: spec.trace,
    onEvent: (event) => {
      if (event.type === "tool_execution_start" && event.toolName === submitTool.name) {
        submitAttempts++;
      }
    },
  });

  if (!run.ok) {
    if (run.error === "CANCELLED") return { ok: false, error: "CANCELLED" };
    if (run.error === "MODEL_CONTENT_REJECTED") return { ok: false, error: "MODEL_CONTENT_REJECTED" };
    if (run.error === "TIMEOUT" || run.error === "MODEL_NOT_CONFIGURED") {
      return { ok: false, error: "MODEL_REQUEST_FAILED" };
    }
    return {
      ok: false,
      error: submitted || submitAttempts > 0 ? "INVALID_MODEL_RESULT" : "MODEL_REQUEST_FAILED",
    };
  }
  if (!submitted || validSubmissions !== 1) {
    return {
      ok: false,
      error: submitted || submitAttempts > 0 ? "INVALID_MODEL_RESULT" : "MODEL_REQUEST_FAILED",
    };
  }
  try {
    spec.validateSubmitted(submitted);
  } catch {
    return { ok: false, error: "INVALID_MODEL_RESULT" };
  }
  return { ok: true, value: submitted };
};
