import type { ConversationHub } from "../conversation/conversation-hub.js";
import { isAgentId } from "../conversation/agent-id.js";
import type { JobService } from "../jobs/job-service.js";
import type { MonitorService } from "../monitors/monitor-service.js";
import type { ActionService } from "../actions/action-service.js";
import type { DreamService } from "../dream/service.js";
import type { InformationService } from "../information/service.js";
import type { AgentCommunication } from "../agent-communication/service.js";
import type { GroupChat } from "../group-chat/service.js";
import type { GroupRouting } from "../group-chat/routing.js";
import type { FeatureService } from "../agent-extensions/service.js";
import type { MessageFeedbackRepository } from "../messages/types.js";
import { isFeatureAgent } from "../agent-extensions/types.js";
import { AgentError, describeAgent, type AgentStorage } from "./types.js";

type Dependencies = {
  forgetPresence?: (agentId: string) => void;
  conversationHub: ConversationHub;
  storage: AgentStorage;
  jobs: JobService;
  monitors: MonitorService;
  actions: ActionService;
  dream: DreamService;
  information: InformationService;
  communication: AgentCommunication;
  group: GroupChat;
  groupRouting: GroupRouting;
  features: FeatureService;
  messageFeedbackRepository: MessageFeedbackRepository;
};

/** Agent 生命周期唯一入口；HTTP 不直接操作历史或级联清理，读取目录不创建会话。 */
export const createAgentService = (deps: Dependencies) => {
  const { conversationHub, storage, jobs, monitors, actions, dream, information, messageFeedbackRepository } = deps;
  const list = async () => (await conversationHub.agents()).map(describeAgent);
  const create = async (agentId: string) => {
    if (!isAgentId(agentId) || agentId.startsWith("task-") || isFeatureAgent(agentId))
      throw new AgentError(400, "INVALID_AGENT_ID", "Invalid agentId");
    return conversationHub.withAgent(agentId, async () => describeAgent((await conversationHub.agents()).find((agent) => agent.id === agentId)!));
  };
  const reset = async (agentId: string, clearSchedules = false) => {
    if (!isAgentId(agentId)) throw new AgentError(400, "INVALID_AGENT_ID", "Invalid agentId");
    deps.group.cancelPlanning();
    // 暂停屏障覆盖完整锁窗口，避免两次 cancel 之间又启动新后台轮。
    const pause = information.pauseAgent(agentId);
    const communicationPause = deps.communication.pauseAgent(agentId);
    await Promise.all([pause.stopped, communicationPause.stopped]);
    try {
      return await conversationHub.resetAgent(agentId, async ({ closeCurrent, reopen }) => {
        // 1. 记录重置前归属于该智能体的待审批项 ID，用于准确统计作废项
        const pendingBefore = (await actions.snapshotPending()).filter((a) => {
          const actionAgentId = a.agentId;
          const workspaceAgentId = a.workspaceAgentId;
          return actionAgentId === agentId || workspaceAgentId === agentId;
        });
        const pendingIdsBefore = new Set(pendingBefore.map((a) => a.id));

        // 2. 优先取消归属于该智能体的待审批项（在 closeCurrent 之前执行，主动触发取消）
        const cancelledFirst = await actions.cancelByAgentId(agentId);

        // 3. 关闭当前活跃的协调器与模型运行；信息在途轮已在进入锁前取消。
        await closeCurrent();

        // 4. 补查一次是否有运行关闭期间被撤销或残留的审批项
        const cancelledSecond = await actions.cancelByAgentId(agentId);
        const cancelledIds = new Set([...cancelledFirst, ...cancelledSecond]);
        for (const id of pendingIdsBefore) {
          const action = await actions.get(id);
          if (action?.status === "cancelled") {
            cancelledIds.add(id);
          }
        }

        // 5. 清理会话历史 JSONL 文件，保留 skills.json / INSTRUCTIONS.md / DREAM.md / dream.json
        await storage.clearSessions(agentId);
        await deps.communication.removeDiscussions(agentId);
        await deps.group.removeAgent(agentId);

        // 6. 反馈与会话同生命周期；旧 sessionId 文件删除，不能迁移到 reset 后的新会话
        await messageFeedbackRepository.removeAgent(agentId);
        await deps.features.clearConversationLinks(agentId);

        // 7. 重置该智能体的 Dream 整理游标与待决项
        await dream.resetAgent(agentId);

        // 8. 若勾选清理调度，级联删除该智能体下的定时任务与监控
        let removedJobs = 0;
        let removedMonitors = 0;
        if (clearSchedules) {
          removedJobs = await jobs.removeByOriginAgentId(agentId);
          removedMonitors = await monitors.removeByOriginAgentId(agentId);
        } else {
          await monitors.clearPendingByOriginAgentId(agentId);
        }

        // 9. 用全新的 sessionId 重新打开并初始化该智能体
        const nextConversation = await reopen();
        deps.forgetPresence?.(agentId);

        return {
          ok: true,
          agentId,
          sessionId: nextConversation.sessionId(),
          cancelledApprovals: cancelledIds.size,
          removed: {
            jobs: removedJobs,
            monitors: removedMonitors,
          },
        };
      });
    } finally {
      pause.resume();
      communicationPause.resume();
    }
  };
  const remove = async (agentId: string) => {
    // 内置成员负责持久化功能数据，不能从成员主页删除。
    if (isFeatureAgent(agentId)) throw new AgentError(409, "CANNOT_DELETE_BUILTIN_AGENT", "Cannot delete a built-in agent");

    // 1. 主智能体保护
    if (agentId === "local-main") {
      throw new AgentError(409, "CANNOT_DELETE_MAIN_AGENT", "Cannot delete the main agent");
    }
    if (!isAgentId(agentId)) {
      throw new AgentError(400, "INVALID_AGENT_ID", "Invalid agentId");
    }

    await deps.features.assertCanDelete(agentId);
    await deps.groupRouting.assertCanDelete(agentId);
    deps.group.cancelPlanning();

    // 删除全程暂停信息后台，且不在 hub 锁内等待 retain。
    const pause = information.pauseAgent(agentId);
    const communicationPause = deps.communication.pauseAgent(agentId);
    await Promise.all([pause.stopped, communicationPause.stopped]);
    try {
      return await conversationHub.deleteAgent(agentId, async () => {
        await deps.features.assertCanDelete(agentId);
        await deps.groupRouting.assertCanDelete(agentId);
        const dirExists = await storage.exists(agentId);
        const hasJobs = (await jobs.list()).some((j) => j.originAgentId === agentId);
        const hasMonitors = (await monitors.list()).some((m) => m.originAgentId === agentId);
        if (!dirExists && !hasJobs && !hasMonitors)
          throw new AgentError(404, "AGENT_NOT_FOUND", "Agent not found");

        // 生命周期锁已关闭旧协调器；等待所有来源绑定提交后再级联清理。
        const removedJobs = await jobs.removeByOriginAgentId(agentId);
        const removedMonitors = await monitors.removeByOriginAgentId(agentId);
        await actions.cancelByAgentId(agentId);
        await messageFeedbackRepository.removeAgent(agentId);
        await deps.features.clearConversationLinks(agentId);
        await information.removeAgent(agentId);
        await deps.communication.removeDiscussions(agentId);
        await deps.group.removeAgent(agentId);
        await deps.groupRouting.removeAgent(agentId);
        await storage.remove(agentId);
        deps.forgetPresence?.(agentId);
        return { ok: true as const, removed: { jobs: removedJobs, monitors: removedMonitors } };
      });
    } finally {
      pause.resume();
      communicationPause.resume();
    }
  };
  return { list, create, reset, remove };
};
export type AgentService = ReturnType<typeof createAgentService>;
