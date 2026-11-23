/** 全站统一的用户反馈基础原语，供聊天消息与领域条目共用，不绑定特定消费者。 */
export type UserReaction = "like" | "dislike";

export type UserFeedbackComment = {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
};

export type UserFeedbackSnapshot = {
  reaction: UserReaction | null;
  saved: boolean;
  comments: UserFeedbackComment[];
};
