import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { StatusRun } from "../../features/workspace/session-status.js";
import type { ToolPresentation } from "../ag-ui/tool-presentation.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const compactText = (value: unknown, max = 160): string | null => {
  if (typeof value !== "string") return null;
  const line = value.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const safeUrlSummary = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const path = url.pathname && url.pathname !== "/" ? url.pathname : "";
    return compactText(`${url.host}${path}`, 160);
  } catch {
    return compactText(value, 160);
  }
};

const toolTitle = (name: string): string => ({
  search_web: "搜索网页",
  web_fetch: "读取网页",
  browser: "操作浏览器",
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  grep: "搜索文件内容",
  find: "查找文件",
  ls: "列出目录",
  subagent: "委派子代理",
  memory: "管理记忆",
  memory_search: "检索记忆",
  schedule: "管理定时任务",
  monitor: "管理网页监控",
  goal: "管理目标",
  get_weather: "查询天气",
  currentTime: "查询当前时间",
  instructions: "管理助手指令",
  skills: "管理技能",
  database: "操作数据库",
}[name] ?? "执行工具");

/** 只从白名单字段提取人类可读且脱敏后的简要摘要；不透出正文、SQL、凭据或原始载荷。 */
const summarizeToolDetail = (name: string, args: unknown): string | null => {
  if (!isObject(args)) return null;
  switch (name) {
    case "search_web":
    case "memory_search":
      return compactText(args.query);
    case "web_fetch":
      return safeUrlSummary(args.url);
    case "read":
    case "write":
    case "edit":
      return compactText(args.path);
    case "ls":
      return compactText(args.path) ?? ".";
    case "grep":
    case "find":
      return compactText([compactText(args.pattern, 80), compactText(args.path, 80)].filter(Boolean).join(" · "));
    case "browser": {
      const action = compactText(args.action, 40);
      const target = safeUrlSummary(args.url);
      return compactText([action, target].filter(Boolean).join(" · "));
    }
    case "subagent": {
      const tasks = Array.isArray(args.tasks) ? args.tasks : [];
      const agents = tasks
        .map((task) => (isObject(task) ? compactText(task.agent, 40) : null))
        .filter((agent): agent is string => Boolean(agent));
      return agents.length ? compactText(agents.join("、")) : null;
    }
    case "skills":
      return compactText([compactText(args.action, 32), compactText(args.name, 64)].filter(Boolean).join(" "));
    case "database":
      return compactText(args.database) ?? "main";
    case "get_weather":
      return compactText(args.city);
    case "memory":
    case "schedule":
    case "monitor":
    case "goal":
    case "instructions":
      return compactText(args.action, 40);
    default:
      return null;
  }
};

/** 观察 pi 真实事件，更新运行状态投影并在本轮 steps 中沉淀脱敏执行步骤。 */
export const createStatusObserver = (
  status: StatusRun,
  presentation: ToolPresentation,
  subagentId: string | null,
  parentId: string | null = null,
) => {
  let responding = false;
  const detailsByCallId = new Map<string, { detail: string | null; saveSkill: boolean }>();
  const prefix = subagentId ?? "main";

  return (event: AgentSessionEvent) => {
    if (event.type === "turn_start") {
      responding = false;
      status.observe({ kind: "model", phase: "start", subagentId });
    }
    if (event.type === "message_update" && !responding && event.assistantMessageEvent.type === "text_delta") {
      responding = true;
      status.observe({ kind: "model", phase: "responding", subagentId });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      status.observe({ kind: "model", phase: "end", subagentId });
    }
    if (event.type === "tool_execution_start") {
      const hidden = presentation.modeFor(event.toolName) === "hidden";
      const detail = summarizeToolDetail(event.toolName, event.args);
      const saveSkill = event.toolName === "skills" && isObject(event.args) && event.args.action === "save";
      detailsByCallId.set(event.toolCallId, { detail, saveSkill });
      status.observe({
        kind: "tool",
        phase: "start",
        toolCallId: event.toolCallId,
        name: hidden ? null : event.toolName,
        subagentId,
        title: toolTitle(event.toolName),
        detail,
        stepId: `${prefix}:tool:${event.toolCallId}`,
        parentId,
      });
    }
    if (event.type === "tool_execution_end") {
      const hidden = presentation.modeFor(event.toolName) === "hidden";
      const recorded = detailsByCallId.get(event.toolCallId);
      detailsByCallId.delete(event.toolCallId);
      const result = event.result as { details?: { denied?: boolean } } | undefined;
      const denied = Boolean(event.isError && result?.details?.denied === true);
      const stepStatus = denied ? "denied" : event.isError ? "failed" : "succeeded";
      const stepId = `${prefix}:tool:${event.toolCallId}`;
      status.observe({
        kind: "tool",
        phase: "end",
        toolCallId: event.toolCallId,
        name: hidden ? null : event.toolName,
        subagentId,
        title: toolTitle(event.toolName),
        detail: recorded?.detail ?? null,
        status: stepStatus,
        result: denied ? "操作被拒绝" : event.isError ? "执行失败" : "已完成",
        stepId,
        parentId,
      });
      if (event.toolName === "write" || event.toolName === "edit" || recorded?.saveSkill) {
        status.observe({
          kind: "file_commit",
          phase: "end",
          id: `${stepId}:commit`,
          parentId: stepId,
          title: "文件提交",
          detail: recorded?.detail ?? null,
          status: stepStatus,
          result: denied ? "未批准，未写入文件" : event.isError ? "文件写入失败" : "文件已写入并完成校验",
        });
      }
    }
  };
};
