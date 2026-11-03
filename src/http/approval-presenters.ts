import type { PendingAction } from "../features/actions/types.js";

/** 预览只投影当次绑定的完整文本，不读当前文件替代，不返回物理路径/版本指纹。 */
export const presentApproval = (action: PendingAction) => {
  const path = action.payload.path;
  const resourceScope = action.payload.resourceScope;
  if (resourceScope === "skill") {
    const { payload: _payload, ...summary } = action;
    const agentId = action.agentId ?? null;
    return {
      ...summary,
      agentId,
      workspaceAgentId: null,
      execution: action.execution ?? null,
      preview: {
        scope: "skill" as const,
        ownerAgentId: null,
        path,
        before: action.payload.originalContent,
        after: action.payload.content,
        beforeExists: action.payload.beforeExists === "true",
      },
    };
  }
  const shared = path === "shared" || path.startsWith("shared/");
  const { payload: _payload, ...summary } = action;
  const agentId = action.agentId ?? null;
  const workspaceAgentId = action.workspaceAgentId ?? null;
  return {
    ...summary,
    agentId,
    workspaceAgentId,
    execution: action.execution ?? null,
    preview: {
      scope: shared ? ("shared" as const) : ("agent" as const),
      ownerAgentId: shared ? null : workspaceAgentId,
      path,
      before: action.payload.originalContent,
      after: action.payload.content,
      beforeExists: action.payload.beforeExists === "true",
    },
  };
};

export const presentApprovalResolution = (action: PendingAction) => {
  const agentId = action.agentId ?? null;
  const workspaceAgentId = action.workspaceAgentId ?? null;
  return {
    id: action.id,
    revision: action.revision,
    agentId,
    runId: action.runId,
    toolCallId: action.toolCallId,
    subagentId: action.subagentId,
    workspaceAgentId,
    activityId: action.activityId,
    status: action.status,
    createdAt: action.createdAt,
    expiresAt: action.expiresAt,
    resolvedAt: action.resolvedAt,
    decidedAt: action.decidedAt,
    execution: action.execution ?? null,
  };
};
