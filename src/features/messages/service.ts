import { randomUUID } from "node:crypto";
import {
  type FeedbackTargetRole,
  type MessageComment,
  type MessageExecutionFact,
  type MessageFeedback,
  type MessageFeedbackDocument,
  type MessageFeedbackEvent,
  type MessageFeedbackFilter,
  type MessageFeedbackListItem,
  type MessageFeedbackRepository,
  type ProjectedMessageMetadata,
  type ProjectedMessage,
} from "./types.js";

export class MessageFeedbackDomainError extends Error {
  constructor(
    public code: "INVALID_INPUT" | "NOT_FOUND" | "SESSION_CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

export const normalizeComment = (rawText: string): string => {
  const text = rawText.trim();
  if (!text) throw new MessageFeedbackDomainError("INVALID_INPUT", "Comment cannot be empty");
  if (text.length > 4000) throw new MessageFeedbackDomainError("INVALID_INPUT", "Comment must be at most 4000 characters");
  return text;
};

type FeedbackAccumulator = {
  reaction: MessageFeedback["reaction"];
  saved: boolean;
  comments: Map<string, MessageComment>;
};

export const emptyMessageFeedback = (): MessageFeedback => ({
  reaction: null,
  saved: false,
  comments: [],
});

const createAccumulator = (): FeedbackAccumulator => ({
  reaction: null,
  saved: false,
  comments: new Map<string, MessageComment>(),
});

const applyFeedbackEvent = (state: FeedbackAccumulator, event: MessageFeedbackEvent): void => {
  switch (event.type) {
    case "reaction_changed":
      state.reaction = event.to;
      return;
    case "saved_changed":
      state.saved = event.to;
      return;
    case "comment_added":
      state.comments.set(event.commentId, {
        id: event.commentId,
        text: event.text,
        createdAt: event.at,
        updatedAt: event.at,
      });
      return;
    case "comment_edited": {
      const comment = state.comments.get(event.commentId);
      if (comment) {
        comment.text = event.toText;
        comment.updatedAt = event.at;
      }
      return;
    }
    case "comment_deleted":
      state.comments.delete(event.commentId);
      return;
  }
};

const finalizeFeedback = (state: FeedbackAccumulator): MessageFeedback => ({
  reaction: state.reaction,
  saved: state.saved,
  comments: [...state.comments.values()],
});

export const projectFeedbackMap = (
  document: MessageFeedbackDocument,
): Map<string, MessageFeedback> => {
  const accumulators = new Map<string, FeedbackAccumulator>();
  for (const event of document.events) {
    let entry = accumulators.get(event.messageId);
    if (!entry) {
      entry = createAccumulator();
      accumulators.set(event.messageId, entry);
    }
    applyFeedbackEvent(entry, event);
  }
  const projected = new Map<string, MessageFeedback>();
  for (const [messageId, entry] of accumulators) {
    projected.set(messageId, finalizeFeedback(entry));
  }
  return projected;
};

export const projectFeedback = (
  document: MessageFeedbackDocument,
  messageId: string,
): MessageFeedback => {
  const state = createAccumulator();
  for (const event of document.events) {
    if (event.messageId === messageId) {
      applyFeedbackEvent(state, event);
    }
  }
  return finalizeFeedback(state);
};

export const hasActiveFeedback = (feedback: MessageFeedback): boolean =>
  feedback.reaction !== null || feedback.saved || feedback.comments.length > 0;

const matchesFilter = (feedback: MessageFeedback, filter?: MessageFeedbackFilter): boolean => {
  if (filter?.saved !== undefined && feedback.saved !== filter.saved) return false;
  if (filter?.reaction !== undefined && feedback.reaction !== filter.reaction) return false;
  if (filter?.saved === undefined && filter?.reaction === undefined) return hasActiveFeedback(feedback);
  return true;
};

const withEvent = (
  document: MessageFeedbackDocument,
  event: MessageFeedbackEvent,
): MessageFeedbackDocument => ({
  schemaVersion: 1,
  events: [...document.events, event],
});

/**
 * 每个 conversation 绑定一个反馈会话。执行事实从 PI adapter 实时读取；
 * 反馈事件独立持久化在 main.sqlite，不进入模型上下文，也不改变 PI 会话 revision。
 */
export const createMessageFeedbackSession = (input: {
  sessionId: string;
  piSessionId: () => string;
  facts: () => readonly MessageExecutionFact[];
  repository: MessageFeedbackRepository;
  onFeedbackChanged?: (change: {
    sessionId: string;
    piSessionId: string;
    messageId: string;
    fact: MessageExecutionFact & { role: FeedbackTargetRole };
    feedback: MessageFeedback;
  }) => Promise<void> | void;
}) => {
  let activeRunId: string | null = null;
  const currentPiSessionId = input.piSessionId;
  const available = (fact: MessageExecutionFact) =>
    fact.feedbackAvailable && (activeRunId === null || fact.runId !== activeRunId);
  const guardSession = (piSessionId: string) => {
    if (piSessionId !== currentPiSessionId()) {
      throw new MessageFeedbackDomainError("SESSION_CONFLICT", "Feedback belongs to an old session");
    }
  };
  const facts = () => input.facts();
  const target = (messageId: string, piSessionId: string): MessageExecutionFact & { role: FeedbackTargetRole } => {
    guardSession(piSessionId);
    const fact = facts().find((item) => item.id === messageId);
    if (!fact || (fact.role !== "user" && fact.role !== "assistant")) {
      throw new MessageFeedbackDomainError("NOT_FOUND", "Message not found");
    }
    if (!available(fact)) {
      throw new MessageFeedbackDomainError("NOT_FOUND", "Message is not available for feedback");
    }
    return fact;
  };
  const append = async (
    messageId: string,
    piSessionId: string,
    create: (document: MessageFeedbackDocument, role: FeedbackTargetRole) => {
      document?: MessageFeedbackDocument;
      feedback: MessageFeedback;
    },
  ) => {
    const fact = target(messageId, piSessionId);
    const scopePiSessionId = currentPiSessionId();
    let mutated = false;
    const feedback = await input.repository.update(input.sessionId, scopePiSessionId, (document) => {
      const changed = create(document, fact.role);
      if (changed.document) mutated = true;
      return { ...(changed.document ? { document: changed.document } : {}), result: changed.feedback };
    });
    if (mutated) {
      await input.onFeedbackChanged?.({
        sessionId: input.sessionId,
        piSessionId: scopePiSessionId,
        messageId,
        fact,
        feedback,
      });
    }
    return feedback;
  };
  return {
    piSessionId: currentPiSessionId,
    setActiveRun: (runId: string | null) => { activeRunId = runId; },
    async get(messageId: string, piSessionId: string): Promise<MessageFeedback> {
      target(messageId, piSessionId);
      return projectFeedback(await input.repository.read(input.sessionId, currentPiSessionId()), messageId);
    },
    async events(messageId: string, piSessionId: string) {
      target(messageId, piSessionId);
      return (await input.repository.read(input.sessionId, currentPiSessionId()))
        .events.filter((event) => event.messageId === messageId);
    },
    async list(piSessionId: string, filter?: MessageFeedbackFilter): Promise<MessageFeedbackListItem[]> {
      guardSession(piSessionId);
      const scopePiSessionId = currentPiSessionId();
      const factMap = new Map(facts().map((fact) => [fact.id, fact]));
      const document = await input.repository.read(input.sessionId, scopePiSessionId);
      const feedbackByMessage = projectFeedbackMap(document);
      if (input.repository.listStates) {
        const states = await input.repository.listStates(input.sessionId, scopePiSessionId, filter);
        const items: MessageFeedbackListItem[] = [];
        for (const state of states) {
          const fact = factMap.get(state.messageId);
          if (!fact || !available(fact)) continue;
          const feedback = feedbackByMessage.get(state.messageId) ?? emptyMessageFeedback();
          if (!matchesFilter(feedback, filter)) continue;
          items.push({
            messageId: state.messageId,
            role: fact.role,
            feedback,
            updatedAt: state.updatedAt,
          });
        }
        return items;
      }
      const latestAtByMessage = new Map<string, string>();
      for (const event of document.events) {
        latestAtByMessage.set(event.messageId, event.at);
      }
      const items: MessageFeedbackListItem[] = [];
      for (const fact of facts()) {
        if (!available(fact)) continue;
        const feedback = feedbackByMessage.get(fact.id) ?? emptyMessageFeedback();
        if (!matchesFilter(feedback, filter)) continue;
        const updatedAt = latestAtByMessage.get(fact.id) ?? fact.createdAt;
        items.push({
          messageId: fact.id,
          role: fact.role,
          feedback,
          updatedAt,
        });
      }
      items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.messageId.localeCompare(right.messageId));
      return items;
    },
    setReaction(piSessionId: string, messageId: string, reaction: "like" | "dislike" | null) {
      return append(messageId, piSessionId, (document, role) => {
        const feedback = projectFeedback(document, messageId);
        if (feedback.reaction === reaction) return { feedback };
        const next = withEvent(document, {
          id: randomUUID(), type: "reaction_changed", messageId, role,
          from: feedback.reaction, to: reaction, at: new Date().toISOString(),
        });
        return { document: next, feedback: projectFeedback(next, messageId) };
      });
    },
    setSaved(piSessionId: string, messageId: string, saved: boolean) {
      return append(messageId, piSessionId, (document, role) => {
        const feedback = projectFeedback(document, messageId);
        if (feedback.saved === saved) return { feedback };
        const next = withEvent(document, {
          id: randomUUID(), type: "saved_changed", messageId, role,
          from: feedback.saved, to: saved, at: new Date().toISOString(),
        });
        return { document: next, feedback: projectFeedback(next, messageId) };
      });
    },
    addComment(piSessionId: string, messageId: string, text: string) {
      const normalized = normalizeComment(text);
      return append(messageId, piSessionId, (document, role) => {
        const next = withEvent(document, {
          id: randomUUID(), type: "comment_added", messageId, role,
          commentId: randomUUID(), text: normalized, at: new Date().toISOString(),
        });
        return { document: next, feedback: projectFeedback(next, messageId) };
      });
    },
    editComment(piSessionId: string, messageId: string, commentId: string, text: string) {
      const normalized = normalizeComment(text);
      return append(messageId, piSessionId, (document, role) => {
        const feedback = projectFeedback(document, messageId);
        const comment = feedback.comments.find((item) => item.id === commentId);
        if (!comment) throw new MessageFeedbackDomainError("NOT_FOUND", "Comment not found");
        if (comment.text === normalized) return { feedback };
        const next = withEvent(document, {
          id: randomUUID(), type: "comment_edited", messageId, role, commentId,
          fromText: comment.text, toText: normalized, at: new Date().toISOString(),
        });
        return { document: next, feedback: projectFeedback(next, messageId) };
      });
    },
    deleteComment(piSessionId: string, messageId: string, commentId: string) {
      return append(messageId, piSessionId, (document, role) => {
        const feedback = projectFeedback(document, messageId);
        const comment = feedback.comments.find((item) => item.id === commentId);
        if (!comment) throw new MessageFeedbackDomainError("NOT_FOUND", "Comment not found");
        const next = withEvent(document, {
          id: randomUUID(), type: "comment_deleted", messageId, role, commentId,
          text: comment.text, at: new Date().toISOString(),
        });
        return { document: next, feedback: projectFeedback(next, messageId) };
      });
    },
    async project<T extends ProjectedMessage>(messages: readonly T[]): Promise<T[]> {
      const executionFacts = new Map(input.facts().map((fact) => [`${fact.role}:${fact.id}`, fact]));
      const feedbackByMessage = projectFeedbackMap(
        await input.repository.read(input.sessionId, currentPiSessionId()),
      );
      return messages.map((message) => {
        const fact = executionFacts.get(`${message.role}:${message.id}`);
        if (!fact || message.role === "tool") return message;
        const projected: ProjectedMessageMetadata = {
          createdAt: fact.createdAt,
          source: fact.source,
          runId: fact.runId,
          jobId: fact.jobId,
          notificationId: fact.notificationId,
          domainId: fact.domainId,
          feedbackAvailable: available(fact),
        };
        return {
          ...message,
          metadata: projected,
          feedback: feedbackByMessage.get(message.id) ?? emptyMessageFeedback(),
        } as T;
      });
    },
  };
};

export type MessageFeedbackSession = ReturnType<typeof createMessageFeedbackSession>;
