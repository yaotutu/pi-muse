import type { PendingAction } from "../features/actions/types.js";

/** 预览只投影当次绑定的完整文本，不读当前文件替代，不返回物理路径/版本指纹。 */
export const presentApproval = (action: PendingAction) => {
  const path = action.payload.path;
  const resourceScope = action.payload.resourceScope;
  if (resourceScope === "skill") {
    const { payload: _payload, ...summary } = action;
    const sessionId = action.sessionId ?? null;
    return {
      ...summary,
      sessionId,
      execution: action.execution ?? null,
      preview: {
        scope: "skill" as const,
        path,
        before: action.payload.originalContent,
        after: action.payload.content,
        beforeExists: action.payload.beforeExists === "true",
      },
    };
  }
  const { payload: _payload, ...summary } = action;
  const sessionId = action.sessionId ?? null;
  return {
    ...summary,
    sessionId,
    execution: action.execution ?? null,
    preview: {
      scope: "workspace" as const,
      path,
      before: action.payload.originalContent,
      after: action.payload.content,
      beforeExists: action.payload.beforeExists === "true",
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
    activityId: action.activityId,
    status: action.status,
    createdAt: action.createdAt,
    expiresAt: action.expiresAt,
    resolvedAt: action.resolvedAt,
    decidedAt: action.decidedAt,
    execution: action.execution ?? null,
  };
};
