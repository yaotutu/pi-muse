import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { safeWorkspacePath } from "./tools/workspace-path.js";
import {
  createAgentSession,
  createExtensionRuntime,
  discoverAndLoadExtensions,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Skill,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { DataLayout } from "../storage/data-layout.js";
import { readResolvedProfileFile } from "../storage/workspace-document-includes.js";
import { loadEnabledProductSkills, type EnabledProductSkill } from "./enabled-skills.js";
import type { Config } from "../../config/load-config.js";
import type { MemoryService } from "../../features/memory/memory-service.js";
import type { JobService } from "../../features/jobs/job-service.js";
import type { GoalService } from "../../features/goals/goal-service.js";
import type { ActionService } from "../../features/actions/action-service.js";
import type { MonitorService } from "../../features/monitors/monitor-service.js";
import type { WebService } from "../../features/web/types.js";
import type { WeatherService } from "../../features/weather/types.js";
import type { BrowserService } from "../../features/browser/browser-service.js";
import type { SkillsService } from "../../features/skills/service.js";
import type { SubagentRegistry } from "../../features/subagents/registry.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createResourceLoader } from "./resource-loader.js";
import { createTools, skillToToolsMap, registeredToolNames } from "./tools/index.js";
import { createMcpTools } from "./tools/mcp.js";
import { createWritableFileTools } from "./tools/files-writable.js";
import type { McpService } from "../../features/mcp/types.js";
import type { ReadOnlyFile } from "./tools/path-guard.js";
import { createSubagentExtension, SUBAGENT_TOOL_NAME } from "./subagent/extension.js";
import { createToolPresentation, type ToolPresentation } from "../ag-ui/tool-presentation.js";
import type { WorkspaceCommitQueue } from "../workspace/file-commit-queue.js";
import type { StatusRun } from "../../features/workspace/session-status.js";
import { createStatusObserver } from "./status-observer.js";

/**
 * pi 装配的依赖集合。全部经由组合入口显式注入；可选能力（goals/actions/
 * monitors/web/weather/subagents）缺省时对应工具不声明，不留第二套装配路径。
 */
export type PiDeps = {
  config: Config;
  layout: DataLayout;
  /** 组合层预构建的 runtime（provider/key 已注册）；每轮重建只浪费 I/O。 */
  modelRuntime: ModelRuntime;
  sessionManager: SessionManager;
  memory: MemoryService;
  jobs: JobService;
  sessionId: string;
  runId?: string;
  /** 当前轮次的用户输入文本，用于自动召回长会话记忆线索并注入提示词。 */
  userText?: string;
  goals?: GoalService;
  actions?: ActionService;
  actionTimeoutMs?: number;
  monitors?: MonitorService;
  web?: WebService;
  weather?: WeatherService;
  browser?: BrowserService;
  status?: StatusRun;
  skills?: SkillsService;
  presentation?: ToolPresentation;
  /** 与手动 HTTP 文件入口共用，保证最终版本检查与提交按物理路径串行。 */
  workspaceCommits?: WorkspaceCommitQueue;
  /** 统一专职 Subagent 注册中心；主聊天通过 subagent 工具按能力声明路由任务。 */
  subagents?: SubagentRegistry;
  mcp?: McpService;
  database?: Pick<import("../../features/database/database-service.js").DatabaseService, "execute">;
};

const skillTextResourceExtensions = new Set([".md", ".txt", ".json", ".csv", ".yaml", ".yml"]);
const skillToolEntries = Object.entries(skillToToolsMap);
const skillControlledToolNames = new Set(skillToolEntries.flatMap(([, names]) => names));

const computeBuiltinAllowedToolNames = (
  allCustomTools: readonly { name: string }[],
  enabledSkillNames: ReadonlySet<string>,
): string[] =>
  allCustomTools
    .filter((tool) => {
      if (!skillControlledToolNames.has(tool.name)) return true;
      for (const [skillName, toolNames] of skillToolEntries) {
        if (toolNames.includes(tool.name)) return enabledSkillNames.has(skillName);
      }
      return true;
    })
    .map((tool) => tool.name);

const loadSkillExtensions = async (activeSkills: readonly EnabledProductSkill[], layout: DataLayout) => {
  const extensionPaths: string[] = [];
  for (const skill of activeSkills) {
    // 通用技能仅作为标准文本资源使用；用户开启文本不等于授权运行共享目录里的服务端代码。
    if (skill.catalogSource === "shared") continue;
    const extFile = join(skill.baseDir, "extension.ts");
    if (existsSync(extFile)) extensionPaths.push(extFile);
  }

  const extensionResult = extensionPaths.length > 0
    ? await discoverAndLoadExtensions(extensionPaths, layout.root, layout.agentDir)
    : { extensions: [], errors: [], runtime: createExtensionRuntime() };

  const builtinToolNames = new Set(registeredToolNames);
  const extensionToolNames: string[] = [];
  const seenExtensionTools = new Set<string>();

  for (const ext of extensionResult.extensions) {
    if (!(ext.tools instanceof Map)) continue;
    for (const toolName of ext.tools.keys()) {
      if (builtinToolNames.has(toolName)) {
        ext.tools.delete(toolName);
        extensionResult.errors.push({ path: ext.path, error: `Reserved tool name: ${toolName}` });
        continue;
      }
      if (seenExtensionTools.has(toolName)) {
        ext.tools.delete(toolName);
        extensionResult.errors.push({ path: ext.path, error: `Duplicate extension tool: ${toolName}` });
        continue;
      }
      seenExtensionTools.add(toolName);
      extensionToolNames.push(toolName);
    }
  }
  return { extensionResult, extensionToolNames };
};

/** 只把启用技能的精确文本文件交给 read；目录、代码、配置和其他邻居仍不可见。 */
const collectReadableSkillFiles = async (skills: readonly Skill[]): Promise<ReadOnlyFile[]> => {
  const files: ReadOnlyFile[] = [];
  const entryFor = async (
    root: string,
    target: string,
    boundaryDir: string,
  ): Promise<ReadOnlyFile | undefined> => {
    const safe = await safeWorkspacePath(root, target, { boundaryDir }).catch(() => undefined);
    // 保留 SDK 提示中的词法路径；每次 read 再由 guard/operations 重新解析并复核全链路。
    return safe ? { path: resolve(target), root: resolve(root), boundaryDir: resolve(boundaryDir) } : undefined;
  };
  const walkResources = async (directory: string, boundaryDir: string) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stat = await lstat(path).catch(() => undefined);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await walkResources(path, boundaryDir);
      else if (stat.isFile() && entry.name !== "SKILL.md" &&
        skillTextResourceExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
        const file = await entryFor(directory, path, boundaryDir).catch(() => undefined);
        if (file) files.push(file);
      }
    }
  };
  for (const skill of skills) {
    // 技能根或任一祖先若是链接，整体不进入只读例外。
    const skillBoundary = dirname(skill.baseDir);
    const skillFile = await entryFor(skill.baseDir, skill.filePath, skillBoundary).catch(() => undefined);
    if (!skillFile) continue;
    files.push(skillFile);
    const root = skillFile.root;
    for (const resourceDir of ["references", "assets"]) {
      const directory = join(root, resourceDir);
      const stat = await lstat(directory).catch(() => undefined);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) await walkResources(directory, skillBoundary);
    }
  }
  return files;
};

/** 按模型窗口比例计算压缩参数：约 85% 触发压缩，不再按写代码场景砍半预留。 */
export const buildCompactionSettings = (contextWindow: number, maxTokens: number) => {
  const maxReserve = Math.max(1024, Math.floor(contextWindow * 0.25));
  const reserveTokens = Math.min(
    maxReserve,
    Math.max(Math.min(maxTokens, maxReserve), Math.floor(contextWindow * 0.15)),
    32768,
  );
  const keepRecentTokens = Math.min(
    16384,
    Math.max(2048, Math.floor(contextWindow * 0.12)),
    Math.max(1024, Math.floor((contextWindow - reserveTokens) * 0.5)),
  );
  return {
    enabled: true as const,
    reserveTokens,
    keepRecentTokens,
  };
};

/** 装配持久化聊天会话；专职子代理路由统一委托给已注册的 SubagentRegistry。 */
export async function openPi(deps: PiDeps) {
  const { config, layout, sessionManager, memory, jobs, modelRuntime } = deps;
  const { goals, actions, actionTimeoutMs, monitors, web, weather, browser, skills } = deps;
  if (!config.configured) throw new Error("MODEL_NOT_CONFIGURED");
  const cwd = layout.workspaceDir;
  const agentDir = layout.agentDir;
  const presentation = deps.presentation ?? createToolPresentation(config.presentation);

  // 1. 只装配用户已选择的来源身份；关闭、被覆盖以及同名新来源都不会自动加载。
  const selectedSkills = await loadEnabledProductSkills(skills);
  const enabledSkillNames = new Set(selectedSkills.map((skill) => skill.name));
  const activeSkills = selectedSkills.filter((skill) => skill.name !== "browser" || Boolean(browser));
  const { extensionResult, extensionToolNames } = await loadSkillExtensions(activeSkills, layout);

  // 2. 裁剪工具并合并 Extension 工具
  const allCustomTools = createTools({
    root: cwd,
    readOnlyFiles: await collectReadableSkillFiles(activeSkills),
    sessionId: deps.sessionId,
    runId: deps.runId,
    isSubagent: false,
    approvalObserver: deps.status
      ? {
          observe: (event) => deps.status!.observe(event),
          prefix: "main",
        }
      : undefined,
    memory,
    jobs,
    goals,
    actions,
    actionTimeoutMs,
    monitors,
    web,
    weather,
    browser,
    layout,
    skillsService: skills,
    writableEnabled: deps.config.writable.enabled,
    workspaceCommits: deps.workspaceCommits,
    database: deps.database,
  });

  const builtinAllowedToolNames = computeBuiltinAllowedToolNames(allCustomTools, enabledSkillNames);
  const allowedToolNames = [...builtinAllowedToolNames, ...extensionToolNames];
  const customTools = allCustomTools.filter((tool) => allowedToolNames.includes(tool.name));
  const usedNames = new Set(allowedToolNames);
  const activeMcpTools = deps.mcp
    ? (await deps.mcp.getActiveTools({ scope: "assistant" })).filter((tool) => !usedNames.has(tool.exposedName))
    : [];
  if (activeMcpTools.length) {
    const mcpToolDefs = createMcpTools(activeMcpTools);
    customTools.push(...mcpToolDefs);
    allowedToolNames.push(...mcpToolDefs.map((tool) => tool.name));
  }

  const recalledMemories = deps.userText && memory ? await memory.recall(deps.userText) : [];
  const assistantInstructions = await readResolvedProfileFile(layout.assistantInstructionsFile, layout.workspaceDir);

  // 3. 挂载统一专职 Subagent 路由扩展（进入主聊天窗口的消息对主模型直接可见，不再隐藏过滤）
  const inlineExtensions: InlineExtension[] = [];
  const chatSubagents = deps.subagents ? await deps.subagents.listChatDescriptors() : [];
  if (deps.subagents && chatSubagents.length > 0) {
    const registry = deps.subagents;
    const extension = createSubagentExtension(
      chatSubagents,
      async (agent, task, signal, update, parentToolCallId, queuedChildId) => {
        signal?.throwIfAborted();
        const childId = queuedChildId ?? `subagent-${randomUUID()}`;
        const parentStepId = parentToolCallId ? `main:tool:${parentToolCallId}` : null;
        deps.status?.observe({ kind: "subagent", phase: "start", id: childId, role: agent.id, parentId: parentStepId });
        try {
          signal?.throwIfAborted();
          const writable = deps.config.writable.enabled !== false
            ? createWritableFileTools(
                cwd,
                {
                  sessionId: deps.sessionId,
                  runId: deps.runId,
                  subagentId: childId,
                },
                layout.workspaceDir,
                deps.workspaceCommits,
                { allowManagedForSubagent: true },
              )[0]
            : undefined;
          const subscribers = [
            ...(deps.status ? [createStatusObserver(deps.status, presentation, childId, childId)] : []),
          ];

          const result = await registry.runChatTask(agent.id, task, {
            sessionId: deps.sessionId,
            runId: deps.runId,
            subagentId: childId,
            parentToolCallId,
            signal,
            onProgress: (text) => update({ agent: agent.id, task, output: text }),
            writeWorkspaceFile: writable
              ? async (path, content, toolCallId, writeSignal, toolContext) => {
                  const res = await writable.execute(
                    toolCallId,
                    { path, content },
                    writeSignal,
                    undefined,
                    toolContext as Parameters<typeof writable.execute>[4],
                  );
                  const text = res.content?.find((part) => part.type === "text")?.text;
                  return { isError: Boolean(res.isError), text };
                }
              : undefined,
            subscribers,
          });

          const failed = Boolean(result.isError);
          deps.status?.observe({
            kind: "subagent",
            phase: "end",
            id: childId,
            role: agent.id,
            parentId: parentStepId,
            outcome: failed ? "failed" : "succeeded",
            result: failed ? "子代理执行失败" : "子代理已完成",
          });
          return result;
        } catch {
          const cancelled = Boolean(signal?.aborted);
          deps.status?.observe({
            kind: "subagent",
            phase: "end",
            id: childId,
            role: agent.id,
            parentId: parentStepId,
            outcome: cancelled ? "cancelled" : "failed",
            result: cancelled ? "子代理已停止" : "子代理执行失败",
          });
          signal?.throwIfAborted();
          return { agent: agent.id, task, output: "Subagent execution failed", isError: true };
        }
      },
      (id, role) => deps.status?.observe({ kind: "subagent", phase: "queued", id, role }),
    );
    inlineExtensions.push({ name: "pi-muse-subagent", hidden: true, factory: extension });
    allowedToolNames.push(SUBAGENT_TOOL_NAME);
  }

  const inlineLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "",
    extensionFactories: inlineExtensions,
  });
  await inlineLoader.reload();
  const inline = inlineLoader.getExtensions();
  if (inline.errors.length) throw new Error("Inline session extensions could not be loaded");
  extensionResult.extensions.push(...inline.extensions);

  // 4. 构建 System Prompt 并注入技能、全局助手指令与开放路由的 Subagent 清单
  const systemPrompt = await buildSystemPrompt({
    layout,
    memory,
    allowedToolNames,
    assistantInstructions,
    recalledMemories,
    chatSubagents,
    mcpSummaries: deps.mcp?.getPromptSummaries({ scope: "assistant" }),
  });
  const resourceLoader = createResourceLoader(systemPrompt, activeSkills, extensionResult);

  // provider 与内存凭据由 bootstrap 唯一初始化；每轮仅查询模型，避免修改共享 runtime。
  const model = modelRuntime.getModel("personal", config.modelId!);
  if (!model) throw new Error("MODEL_NOT_CONFIGURED");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    sessionManager,
    resourceLoader,
    thinkingLevel: "off",
    customTools,
    tools: allowedToolNames,
    settingsManager: SettingsManager.inMemory({
      compaction: buildCompactionSettings(config.contextWindow, config.maxTokens),
      retry: { enabled: false },
    }),
  });
  if (deps.status) session.subscribe(createStatusObserver(deps.status, presentation, null, null));
  return session;
}
