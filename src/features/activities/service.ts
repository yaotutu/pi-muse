import type { ActivityDetail } from "./types.js";
import type { SessionHub } from "../conversation/conversation-hub.js";

export type ActivityService = {
  list: () => Promise<ActivityDetail[]>;
  get: (id: string) => Promise<ActivityDetail | undefined>;
};

/** 活动只从已有会话的当前会话权威记录投影；删除后不另建存储或复活来源。 */
export const createActivityService = (conversationHub: SessionHub): ActivityService => {
  const list = async (): Promise<ActivityDetail[]> => {
    const all: ActivityDetail[] = [];
    for (const agent of await conversationHub.sessions()) {
      const conversation = await conversationHub.findSession(agent.id);
      if (conversation) all.push(...conversation.activities());
    }
    return all;
  };
  return {
    list,
    get: async (id) => (await list()).find((detail) => detail.activity.id === id),
  };
};
