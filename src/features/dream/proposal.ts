import type { DreamPending, DreamTarget } from "./types.js";

/**
 * 模型通过唯一的 propose_notes 工具提交的建议。
 * 模型只能指定“目标类别”，不能传文件路径；写入哪个文件由服务端按类别决定。
 */
export type ProposedChange =
  | { target: "user" | "soul" | "instructions"; text: string; source: string }
  | { target: "memory"; op: "add"; text: string; source: string }
  | { target: "memory"; op: "edit"; id: string; text: string; source: string }
  | { target: "memory"; op: "delete"; id: string; source: string }
  | { target: "pending"; suggestedTarget: DreamTarget; text: string; source: string };

const MAX_TEXT = 4_000;
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT;

/** 把工具参数解析成受信任的建议；任何字段不合法都整体拒绝，不做猜测式修复。 */
export const parseProposal = (value: unknown): ProposedChange[] | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const changes = (value as { changes?: unknown }).changes;
  if (!Array.isArray(changes) || changes.length > 50) return undefined;
  const parsed: ProposedChange[] = [];
  for (const raw of changes) {
    if (!raw || typeof raw !== "object") return undefined;
    const item = raw as Record<string, unknown>;
    if (!isText(item.source)) return undefined;
    const source = item.source.trim();
    if (item.target === "user" || item.target === "soul" || item.target === "instructions") {
      if (!isText(item.text)) return undefined;
      parsed.push({ target: item.target, text: item.text.trim(), source });
    } else if (item.target === "memory") {
      if (item.op === "add") {
        if (!isText(item.text)) return undefined;
        parsed.push({ target: "memory", op: "add", text: item.text.trim(), source });
      } else if (item.op === "edit") {
        if (!isText(item.id) || !isText(item.text)) return undefined;
        parsed.push({ target: "memory", op: "edit", id: item.id.trim(), text: item.text.trim(), source });
      } else if (item.op === "delete") {
        if (!isText(item.id)) return undefined;
        parsed.push({ target: "memory", op: "delete", id: item.id.trim(), source });
      } else return undefined;
    } else if (item.target === "pending") {
      const suggested = item.suggestedTarget;
      if (!isText(item.text) || (suggested !== "user" && suggested !== "soul" && suggested !== "instructions" && suggested !== "memory"))
        return undefined;
      parsed.push({ target: "pending", suggestedTarget: suggested, text: item.text.trim(), source });
    } else return undefined;
  }
  return parsed;
};

export type Rejected = { change: ProposedChange; reason: string };

/** 校验的上下文：当前内容与会话身份，全部来自服务端读取，不来自模型。 */
export type ProposalContext = {
  existingMemoryIds: ReadonlySet<string>;
};

export type ProposalPlan = {
  /** 可以直接写入的变更。 */
  apply: Extract<ProposedChange, { target: "memory" }>[];
  /** 需要用户决定的条目，来自模型主动标记或服务端降级。 */
  pending: Omit<DreamPending, "id" | "createdAt">[];
  /** 被服务端拒绝的建议，只进入报告计数，不写入。 */
  rejected: Rejected[];
};

/**
 * 服务端对建议的唯一裁决点：能直接写的、必须交给用户的、直接拒绝的。
 * 规则按“不确定就不写”的方向收紧：全局说明与资料写入必须确认，引用不存在的记忆 id 直接拒绝。
 */
export const planProposal = (
  changes: readonly ProposedChange[],
  context: ProposalContext,
): ProposalPlan => {
  const plan: ProposalPlan = { apply: [], pending: [], rejected: [] };
  for (const change of changes) {
    if (change.target === "pending") {
      plan.pending.push({ text: change.text, suggestedTarget: change.suggestedTarget, reason: "ambiguous" });
      continue;
    }
    if (change.target !== "memory") {
      plan.pending.push({ text: change.text, suggestedTarget: change.target, reason: "global_from_session" });
      continue;
    }
    if (change.op !== "add" && !context.existingMemoryIds.has(change.id)) {
      plan.rejected.push({ change, reason: "unknown memory id" });
      continue;
    }
    plan.apply.push(change);
  }
  return plan;
};

/**
 * 把一条新指令并入现有指令文本：追加到末尾。
 * 去重支持单行与多行完整块：已存在的块或单行不重复追加。
 */
export const appendInstructions = (current: string, addition: string): string => {
  const base = current.replace(/\r\n/g, "\n").trim();
  const normalizedAddition = addition.replace(/\r\n/g, "\n").trim();
  if (!normalizedAddition) return base;
  if (!base) return normalizedAddition;

  const baseLines = base.split("\n");
  const additionLines = normalizedAddition.split("\n").map((l) => l.trim());

  if (additionLines.length > 0) {
    const isDuplicate = baseLines.some((_, i) => {
      if (i + additionLines.length > baseLines.length) return false;
      return additionLines.every((addL, idx) => baseLines[i + idx]!.trim() === addL);
    });
    if (isDuplicate) return base;
  }

  return `${base}\n${normalizedAddition}`;
};

/** 把一条新笔记并入 USER/SOUL 的纯文本；按块/行去重，其余内容原样保留。 */
export const appendNote = appendInstructions;
