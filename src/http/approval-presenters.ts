import type { PendingAction } from "../features/actions/types.js";

const FILE_SCOPES = ["workspace", "skill", "profile", "memory", "custom"] as const;
type FileDiffScope = (typeof FILE_SCOPES)[number];

const resolveFileScope = (raw: string | undefined): FileDiffScope =>
  (FILE_SCOPES as readonly string[]).includes(raw ?? "") ? (raw as FileDiffScope) : "workspace";

const parseProposalItems = (raw: string | undefined): Array<{ label: string; value: string }> => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const items: Array<{ label: string; value: string }> = [];
    for (const entry of parsed) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof entry.label === "string" &&
        entry.label.length > 0 &&
        typeof entry.value === "string"
      ) {
        items.push({ label: entry.label, value: entry.value });
        if (items.length >= 20) break;
      }
    }
    return items;
  } catch {
    return [];
  }
};

/** 预览投影：file_diff 保留当次完整前后对比，proposal 投影结构化建议/操作要点。 */
export const presentApproval = (action: PendingAction) => {
  const { payload, ...summary } = action;
  const sessionId = action.sessionId ?? null;
  const execution = action.execution ?? null;

  if (action.kind === "file_write" || action.kind === "file_edit" || payload.previewType === "file_diff") {
    return {
      ...summary,
      sessionId,
      execution,
      preview: {
        type: "file_diff" as const,
        scope: resolveFileScope(payload.resourceScope),
        path: payload.path,
        before: payload.originalContent ?? "",
        after: payload.content ?? "",
        beforeExists: payload.beforeExists === "true",
      },
    };
  }

  return {
    ...summary,
    sessionId,
    execution,
    preview: {
      type: "proposal" as const,
      category: payload.category || "general",
      summary: payload.summary || action.title,
      target: payload.target || null,
      items: parseProposalItems(payload.itemsJson),
      confirmLabel: payload.confirmLabel || null,
      denyLabel: payload.denyLabel || null,
    },
  };
};

export const presentApprovalResolution = (action: PendingAction) => {
  const sessionId = action.sessionId ?? null;
  return {
    id: action.id,
    revision: action.revision,
    sessionId,
    runId: action.runId,
    toolCallId: action.toolCallId,
    subagentId: action.subagentId,
    status: action.status,
    createdAt: action.createdAt,
    expiresAt: action.expiresAt,
    resolvedAt: action.resolvedAt,
    decidedAt: action.decidedAt,
    execution: action.execution ?? null,
  };
};
