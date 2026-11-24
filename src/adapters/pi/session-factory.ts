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
import { buildSystemPrompt } from "./system-prompt.js";
import {
  createDomainNotificationContextExtension,
} from "./domain-notification-context.js";
import type { DomainAgentRegistry } from "../../features/domain-agents/registry.js";
import { createResourceLoader } from "./resource-loader.js";
import { createTools, skillToToolsMap, registeredToolNames } from "./tools/index.js";
import type { ReadOnlyFile } from "./tools/path-guard.js";
import { loadSubagentRoles } from "../storage/subagent-roles.js";
import { createSubagentExtension, SUBAGENT_TOOL_NAME } from "./subagent/extension.js";
import { renderPrompt } from "../prompts/loader.js";
import type { ActivityRun, ActivityObservation } from "../../features/activities/types.js";
import { createActivityObserver } from "./activity-observer.js";
import { createToolPresentation, type ToolPresentation } from "../ag-ui/tool-presentation.js";
import type { WorkspaceCommitQueue } from "../workspace/file-commit-queue.js";
import type { StatusRun } from "../../features/workspace/session-status.js";
import { createStatusObserver } from "./status-observer.js";
import { runSubagent } from "./subagent-runner.js";

/**
 * pi 装配的依赖集合。全部经由组合入口显式注入；可选能力（goals/actions/
 * monitors/web/weather）缺省时对应工具不声明，不留第二套装配路径。
 * 单对象参数消除此前 13 个位置参数的传错序风险。
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
  activity?: ActivityRun;
  skills?: SkillsService;
  presentation?: ToolPresentation;
  /** 与手动 HTTP 文件入口共用，保证最终版本检查与提交按物理路径串行。 */
  workspaceCommits?: WorkspaceCommitQueue;
  /** 主聊天的领域子 Agent 注册表；后台子 Agent 独立运行且绝不反向读取主会话上下文。 */
  domainAgents?: DomainAgentRegistry;
  database?: Pick<import("../../features/database/database-service.js").DatabaseService, "execute">;
};

const subagentBlockedTools = new Set([SUBAGENT_TOOL_NAME, "activity", "schedule", "monitor", "instructions", "bash"]);
const parallelExclusiveTools = new Set(["browser"]);
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

/** 装配持久化聊天会话；子会话委派统一组装后交给 runSubagent 内核执行。 */
export async function openPi(deps: PiDeps) {
  const { config, layout, sessionManager, memory, jobs, modelRuntime } = deps;
  const { goals, actions, actionTimeoutMs, monitors, web, weather, browser, skills } = deps;
  if (!config.configured) throw new Error("MODEL_NOT_CONFIGURED");
  const cwd = layout.workspaceDir;
  const agentDir = layout.agentDir;
  const presentation = deps.presentation ?? createToolPresentation(config.presentation);
  const hasDomainAgents = Boolean(deps.domainAgents?.describeForPrompt().length && deps.sessionId);
  const domainAgentsForSession = hasDomainAgents ? deps.domainAgents : undefined;

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
    currentActivityId: () => deps.status?.snapshot().activityId ?? null,
    activity: deps.activity,
    activityObservation: deps.activity
      ? {
          observe: (event: ActivityObservation) => deps.activity!.observe(event),
          prefix: "main",
          getActivityId: () => deps.activity!.getCurrentActivityId(),
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
    domainAgents: domainAgentsForSession,
    database: deps.database,
  });

  const builtinAllowedToolNames = computeBuiltinAllowedToolNames(allCustomTools, enabledSkillNames);
  const allowedToolNames = [...builtinAllowedToolNames, ...extensionToolNames];
  const customTools = allCustomTools.filter((tool) => allowedToolNames.includes(tool.name));

  const recalledMemories = deps.userText && memory ? await memory.recall(deps.userText) : [];
  const assistantInstructions = await readResolvedProfileFile(layout.assistantInstructionsFile, layout.workspaceDir);

  // 3. 挂载领域卡片隔离扩展，并在启用 task 时把聊天委派统一接入通用 runSubagent。
  const inlineExtensions: InlineExtension[] = [
    {
      name: "pi-muse-domain-notification-context",
      hidden: true,
      factory: createDomainNotificationContextExtension(),
    },
  ];
  let activeParentTools: () => readonly string[] = () => [];
  if (enabledSkillNames.has("task")) {
    const roles = await loadSubagentRoles(layout.subagentsDir);
    const parentSkillIds = selectedSkills.map((skill) => skill.catalogId);
    const extension = createSubagentExtension(
      roles,
      async (role, task, signal, update, parentToolCallId, queuedChildId, parentTools, mode) => {
        signal?.throwIfAborted();
        const childId = queuedChildId ?? `subagent-${randomUUID()}`;
        deps.status?.observe({ kind: "subagent", phase: "start", id: childId, role: role.name });
        const parentStepId = `main:tool:${parentToolCallId}`;
        deps.activity?.observe({
          id: childId,
          parentId: parentStepId,
          kind: "subagent",
          phase: "start",
          title: "Subagent executing",
        });
        try {
          signal?.throwIfAborted();
          const isParallel = mode === "parallel";
          const parentToolSet = new Set(parentTools ?? []);
          const childSelectedSkills = await loadEnabledProductSkills(skills, parentSkillIds);
          const childEnabledNames = new Set(childSelectedSkills.map((skill) => skill.name));
          const childActiveSkills = childSelectedSkills.filter(
            (skill) =>
              !["task", "cron", "monitor"].includes(skill.name) &&
              (skill.name !== "browser" || (Boolean(browser) && !isParallel)),
          );
          const {
            extensionResult: childExtensions,
            extensionToolNames: childExtensionToolNames,
          } = await loadSkillExtensions(childActiveSkills, layout);

          const allChildTools = createTools({
            root: cwd,
            readOnlyFiles: await collectReadableSkillFiles(childActiveSkills),
            sessionId: deps.sessionId,
            runId: deps.runId,
            isSubagent: true,
            subagentId: childId,
            currentActivityId: () => deps.status?.snapshot().activityId ?? null,
            activity: undefined,
            activityObservation: deps.activity
              ? {
                  observe: (event: ActivityObservation) => deps.activity!.observe(event),
                  prefix: childId,
                  getActivityId: () => deps.activity!.getCurrentActivityId(),
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
            browser: isParallel ? undefined : browser,
            layout,
            skillsService: skills,
            writableEnabled: deps.config.writable.enabled,
            workspaceCommits: deps.workspaceCommits,
            domainAgents: parentToolSet.has("domain_agent") ? domainAgentsForSession : undefined,
            database: deps.database,
          });

          const childBuiltinAllowed = computeBuiltinAllowedToolNames(allChildTools, childEnabledNames);
          const childAllowedToolNames = [...childBuiltinAllowed, ...childExtensionToolNames].filter(
            (name) =>
              !subagentBlockedTools.has(name) &&
              !(isParallel && parallelExclusiveTools.has(name)) &&
              parentToolSet.has(name) &&
              (!role.tools || role.tools.includes(name)),
          );
          for (const ext of childExtensions.extensions) {
            for (const name of ext.tools.keys()) {
              if (!childAllowedToolNames.includes(name)) ext.tools.delete(name);
            }
            // 可信扩展可以执行任意服务端代码，但子会话不能借其生命周期钩子重新扩充模型工具。
            ext.handlers.clear();
            ext.commands.clear();
          }

          const childCustomTools = allChildTools.filter((tool) =>
            childAllowedToolNames.includes(tool.name),
          );
          const childSystemPrompt =
            (await buildSystemPrompt({
              layout,
              memory,
              allowedToolNames: childAllowedToolNames,
              recalledMemories,
              domainAgents: childAllowedToolNames.includes("domain_agent")
                ? domainAgentsForSession?.describeForPrompt()
                : undefined,
            })) +
            `\n\n${renderPrompt("assistant/subagent-child.md", { ROLE_SYSTEM_PROMPT: role.systemPrompt })}`;

          const subscribers = [
            ...(deps.activity
              ? [createActivityObserver((event) => deps.activity!.observe(event), presentation, childId, childId)]
              : []),
            ...(deps.status ? [createStatusObserver(deps.status, presentation, childId)] : []),
          ];

          const run = await runSubagent(
            { config, layout, modelRuntime },
            {
              cwd,
              systemPrompt: childSystemPrompt,
              prompt: `Task: ${task}`,
              tools: childCustomTools,
              allowedToolNames: childAllowedToolNames,
              skills: childActiveSkills,
              extensions: childExtensions,
              compaction: true,
              timeoutMs: null,
              signal,
              trace: {
                sessionId: deps.sessionId,
                kind: "subagent",
                extra: { parentSessionId: deps.sessionId, role: role.name },
              },
              subscribers,
              onEvent: (event) => {
                if (event.type === "tool_execution_start" || event.type === "message_end") {
                  update({ agent: role.name, task, output: "Subagent is working" });
                }
              },
            },
          );

          if (!run.ok && run.error === "CANCELLED") {
            deps.status?.observe({
              kind: "subagent",
              phase: "end",
              id: childId,
              role: role.name,
              outcome: "cancelled",
            });
            deps.activity?.observe({
              id: childId,
              parentId: parentStepId,
              kind: "subagent",
              phase: "end",
              status: "cancelled",
              title: "Subagent aborted or failed",
              result: "Subagent execution failed",
            });
            signal?.throwIfAborted();
            return { agent: role.name, task, output: "Subagent execution failed", isError: true };
          }

          const failed = !run.ok;
          deps.status?.observe({
            kind: "subagent",
            phase: "end",
            id: childId,
            role: role.name,
            outcome: failed ? "failed" : "succeeded",
          });
          deps.activity?.observe({
            id: childId,
            parentId: parentStepId,
            kind: "subagent",
            phase: "end",
            status: failed ? "failed" : "succeeded",
            title: failed ? "Subagent failed" : "Subagent completed",
            result: failed ? "Subagent execution failed" : "Subagent completed task",
          });
          return {
            agent: role.name,
            task,
            output: failed ? "Subagent execution failed" : run.text || "(no output)",
            isError: failed,
          };
        } catch {
          deps.status?.observe({
            kind: "subagent",
            phase: "end",
            id: childId,
            role: role.name,
            outcome: signal?.aborted ? "cancelled" : "failed",
          });
          deps.activity?.observe({
            id: childId,
            parentId: parentStepId,
            kind: "subagent",
            phase: "end",
            status: signal?.aborted ? "cancelled" : "failed",
            title: "Subagent aborted or failed",
            result: "Subagent execution failed",
          });
          signal?.throwIfAborted();
          return { agent: role.name, task, output: "Subagent execution failed", isError: true };
        }
      },
      () => activeParentTools(),
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

  // 4. 构建 System Prompt 并注入技能、全局助手指令与 Extension
  const systemPrompt = await buildSystemPrompt({
    layout,
    memory,
    allowedToolNames,
    assistantInstructions,
    recalledMemories,
    domainAgents: domainAgentsForSession?.describeForPrompt(),
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
      compaction: {
        enabled: true,
        reserveTokens: Math.min(16384, Math.floor(config.contextWindow / 2)),
        keepRecentTokens: Math.min(20000, Math.floor(config.contextWindow / 4)),
      },
      retry: { enabled: false },
    }),
  });
  activeParentTools = () => session.getActiveToolNames();
  if (deps.activity) {
    session.subscribe(createActivityObserver((event) => deps.activity!.observe(event), presentation, "main"));
  }
  if (deps.status) session.subscribe(createStatusObserver(deps.status, presentation, null));
  return session;
}
