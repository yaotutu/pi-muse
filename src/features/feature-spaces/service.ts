import { randomUUID } from "node:crypto";
import type { ConversationHub } from "../conversation/conversation-hub.js";
import type { InformationService } from "../information/service.js";
import type { InformationFeedbackExample } from "../information/types.js";
import { projectFeedback } from "../messages/service.js";
import type { MessageFeedbackRepository } from "../messages/types.js";
import { FEATURE_IDS, FEATURE_NAMES, FEATURE_SPACES, FeatureError, isFeatureId, isFeatureSpace, type FeatureId, type FeatureLink, type FeatureRepository, type FeatureSource } from "./types.js";

export const createFeatureService = (deps: { repository: FeatureRepository; hub: ConversationHub; information: InformationService; feedback: MessageFeedbackRepository }) => {
  const requireId = (id: string): FeatureId => { if (!isFeatureId(id)) throw new FeatureError("NOT_FOUND", "Feature not found"); return id; };
  const targetFor = async (id: FeatureId) => (await deps.repository.read()).bindings[id];
  const list = async () => {
    const state = await deps.repository.read();
    return { features: FEATURE_IDS.map((id) => ({ id, name: FEATURE_NAMES[id], targetSpaceId: state.bindings[id] })) };
  };
  const bind = async (rawId: string, spaceId: string) => {
    const id = requireId(rawId);
    if (isFeatureSpace(spaceId)) throw new FeatureError("INVALID_INPUT", "Feature spaces cannot receive user interactions");
    const saved = await deps.hub.withExistingSpace(spaceId, async () => {
      await deps.repository.update((state) => ({ state: { ...state, bindings: { ...state.bindings, [id]: spaceId } }, result: undefined }));
      return { id, name: FEATURE_NAMES[id], targetSpaceId: spaceId };
    });
    if (!saved) throw new FeatureError("NOT_FOUND", "Target space not found");
    return saved;
  };
  const assertCanDelete = async (spaceId: string) => {
    if (Object.values((await deps.repository.read()).bindings).includes(spaceId)) throw new FeatureError("FEATURE_BOUND", "Rebind features before deleting their interaction space");
  };
  const recordDelivery = (link: FeatureLink) => deps.repository.update((state) => ({
    state: { ...state, links: [...state.links.filter((old) => !(old.spaceId === link.spaceId && old.sessionId === link.sessionId && old.messageId === link.messageId)), link] }, result: undefined,
  }));
  const clearConversationLinks = (spaceId: string) => deps.repository.update((state) => ({ state: { ...state, links: state.links.filter((link) => link.spaceId !== spaceId) }, result: undefined }));
  const discussNews = async (articleId: string) => {
    const { article } = await deps.information.getNewsArticle(FEATURE_SPACES.news, articleId);
    const spaceId = await targetFor("news");
    const retained = await deps.hub.retainSpace(spaceId);
    if (!retained) throw new FeatureError("NOT_FOUND", "Target space not found");
    try {
      const source: FeatureSource = { featureId: "news", itemIds: [article.id] };
      const receipt = await retained.conversation.notify(`来自新闻 · ${article.sourceTitle}\n\n${article.title}\n\n${article.content}${article.url ? `\n\n${article.url}` : ""}`, `feature-news-${randomUUID()}`, { featureSource: source });
      await recordDelivery({ ...source, spaceId, sessionId: receipt.sessionId, messageId: receipt.messageId });
      return { spaceId, ...receipt };
    } finally { retained.release(); }
  };
  const sourceFor = async (spaceId: string, messageId: string) => {
    const conversation = await deps.hub.findSpace(spaceId);
    const message = (await conversation?.snapshot())?.messages.find((message) => message.id === messageId);
    const source = message?.metadata?.featureSource;
    if (!source) throw new FeatureError("NOT_FOUND", "No feature source on this conversation message");
    return source;
  };
  /** 工具只能沿当前会话中确实存在的来源访问功能对象，不接受任意内部空间 ID。 */
  const query = async (spaceId: string, input: { action: "overview" | "read" | "feedback"; messageId?: string; itemId?: string; reaction?: "like" | "dislike" | null; comment?: string }) => {
    if (input.action === "overview") return { features: (await list()).features.filter((feature) => feature.targetSpaceId === spaceId) };
    if (!input.messageId) throw new FeatureError("INVALID_INPUT", "messageId is required; use the verified notification source");
    const source = await sourceFor(spaceId, input.messageId);
    const owner = FEATURE_SPACES[source.featureId];
    if (input.action === "read") return { featureId: source.featureId, untrusted: true, items: await Promise.all(source.itemIds.map((id) => deps.information.getItem(owner, id))) };
    if (!input.itemId || !source.itemIds.includes(input.itemId)) throw new FeatureError("INVALID_INPUT", "itemId must belong to this message source");
    if (input.reaction === undefined && !input.comment?.trim()) throw new FeatureError("INVALID_INPUT", "Provide reaction or a non-blank comment");
    if (input.comment !== undefined && (!input.comment.trim() || input.comment.trim().length > 4000)) throw new FeatureError("INVALID_INPUT", "Comment must contain 1 to 4000 characters");
    if (input.reaction !== undefined) await deps.information.setArticleReaction(owner, input.itemId, input.reaction);
    if (input.comment !== undefined) await deps.information.addArticleComment(owner, input.itemId, input.comment);
    return { featureId: source.featureId, itemId: input.itemId, saved: true };
  };
  const feedbackExamples = async (id: FeatureId): Promise<InformationFeedbackExample[]> => {
    const links = (await deps.repository.read()).links.filter((link) => link.featureId === id).slice(-50).reverse();
    const examples: InformationFeedbackExample[] = [];
    for (const link of links) {
      // reset 删除反馈文件与关联；旧 session 的反馈不得投影到新会话或被恢复。
      const feedback = projectFeedback(await deps.feedback.read(link.spaceId, link.sessionId), link.messageId);
      if (!feedback.reaction && !feedback.comments.length) continue;
      const items = await Promise.all(link.itemIds.map(async (itemId) => {
        const { item } = await deps.information.getItem(FEATURE_SPACES[id], itemId);
        return { id: item.id, source: item.source, ...(item.title ? { title: item.title } : {}), content: item.content.slice(0, 2000), contentTruncated: item.content.length > 2000 };
      }));
      examples.push({ runId: "feature-interaction", notificationId: link.messageId, text: `${FEATURE_NAMES[id]}功能反馈`, reaction: feedback.reaction, comments: feedback.comments.slice(-5).map((comment) => comment.text.slice(0, 1000)), commentsTruncated: feedback.comments.length > 5 || feedback.comments.some((comment) => comment.text.length > 1000), items });
      if (examples.length >= 10) break;
    }
    return examples;
  };
  return { list, bind, targetFor, assertCanDelete, recordDelivery, clearConversationLinks, discussNews, query, feedbackExamples };
};
export type FeatureService = ReturnType<typeof createFeatureService>;
