import { randomUUID } from "node:crypto";
import { isSpaceId } from "../conversation/space-id.js";
import type { ConversationHub } from "../conversation/conversation-hub.js";
import type { ConversationHistory } from "../conversation/types.js";
import type { ExecutionEvent } from "../conversation/types.js";
import { FEATURE_NAMES, featureForSpace } from "../feature-spaces/types.js";

export class SpaceCommunicationError extends Error {
  constructor(public code: "INVALID_INPUT" | "NOT_FOUND" | "BUSY" | "SHUTDOWN", message: string) { super(message); }
}

export type SpaceRequest = {
  sourceSpaceId: string;
  targetSpaceId: string;
  message: string;
  discussionId?: string;
  context?: string;
};
export type SpaceRequestReceipt = {
  requestId: string;
  discussionId: string;
  sourceSpaceId: string;
  sourceSessionId: string;
  sourceDiscussionId?: string;
  targetSpaceId: string;
  status: "completed" | "failed" | "cancelled";
  text: string;
};
export type SpaceRequestExecution = Required<Omit<SpaceRequest, "context">> & {
  context?: string;
  requestId: string;
  sourceSessionId: string;
  sourceDiscussionId?: string;
  signal: AbortSignal;
  approvalOwner: { spaceId: string; runId: string };
  group?: boolean;
  onEvent?: (event: ExecutionEvent) => void;
};
export type SpaceDiscussionHistory = { spaceId: string; discussionId: string; messages: ConversationHistory };
export type SpaceCommunicationRunner = {
  run: (request: SpaceRequestExecution, continuing: boolean) => Promise<Pick<SpaceRequestReceipt, "status" | "text">>;
  history: (spaceId: string, discussionId: string) => Promise<SpaceDiscussionHistory>;
  removeDiscussions: (spaceId: string) => Promise<void>;
};
export type SpaceCaller = {
  sessionId: string;
  discussionId?: string;
  approvalOwner?: { spaceId: string; runId: string };
  requestId?: string;
  group?: boolean;
};

const validDiscussionId = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const invalid = () => new SpaceCommunicationError("INVALID_INPUT", "Invalid space communication request");

/** 空间默认互信；此处只协调执行、回复关联和生命周期，不维护调用白名单或绑定权限。 */
export const createSpaceCommunication = (deps: { hub: ConversationHub; runner: SpaceCommunicationRunner; timeoutMs: number;
  onStart?: (request: SpaceRequestExecution) => Promise<void>;
  onFinish?: (receipt: SpaceRequestReceipt) => Promise<void>;
  onEvent?: (requestId: string, event: ExecutionEvent) => void;
}) => {
  const active = new Map<string, { sourceSpaceId: string; targetSpaceId: string; controller: AbortController; done: Promise<void> }>();
  const paused = new Map<string, number>();
  let closed = false;
  const checkOpen = (...spaceIds: string[]) => {
    if (closed) throw new SpaceCommunicationError("SHUTDOWN", "Space communication is closing");
    if (spaceIds.some((id) => paused.has(id))) throw new SpaceCommunicationError("BUSY", "Space is being reset or deleted");
  };
  const requireSpace = async (spaceId: string) => {
    const space = await deps.hub.findSpace(spaceId);
    if (!space) throw new SpaceCommunicationError("NOT_FOUND", "Space not found");
    return space;
  };
  const listSpaces = async () => ({ spaces: (await deps.hub.spaces()).map((space) => {
    const featureId = featureForSpace(space.id);
    return { id: space.id, name: featureId ? FEATURE_NAMES[featureId] : space.id, kind: featureId ? "feature" as const : "workspace" as const };
  }) });

  const request = async (input: SpaceRequest, signal?: AbortSignal, caller?: SpaceCaller): Promise<SpaceRequestReceipt> => {
    if (!isSpaceId(input.sourceSpaceId) || !isSpaceId(input.targetSpaceId) ||
      typeof input.message !== "string" || !input.message.trim() || input.message.length > 20000 ||
      (input.context !== undefined && (typeof input.context !== "string" || input.context.length > 20000)) ||
      (input.discussionId !== undefined && !validDiscussionId(input.discussionId))) throw invalid();
    checkOpen(input.sourceSpaceId, input.targetSpaceId);
    signal?.throwIfAborted();
    const [source] = await Promise.all([requireSpace(input.sourceSpaceId), requireSpace(input.targetSpaceId)]);
    checkOpen(input.sourceSpaceId, input.targetSpaceId);
    signal?.throwIfAborted();
    const discussionId = input.discussionId ?? randomUUID();
    const key = `${input.targetSpaceId}/${discussionId}`;
    if (active.has(key)) throw new SpaceCommunicationError("BUSY", "Discussion is already processing a request");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, deps.timeoutMs);
    const requestId = caller?.requestId ?? randomUUID();
    const sourceSessionId = caller?.sessionId ?? source.sessionId();
    const sourceDiscussionId = caller?.discussionId;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    active.set(key, { sourceSpaceId: input.sourceSpaceId, targetSpaceId: input.targetSpaceId, controller, done });
    try {
      // 回复作为本次调用结果返回，绝不等待来源会话的通知队列，也不重新解析默认通知绑定。
      const execution = { ...input, requestId, discussionId, sourceSessionId, sourceDiscussionId, signal: controller.signal, group: caller?.group,
        onEvent: (event: ExecutionEvent) => deps.onEvent?.(requestId, event),
        approvalOwner: caller?.approvalOwner ?? { spaceId: input.sourceSpaceId, runId: requestId } };
      await deps.onStart?.(execution);
      const result = await deps.runner.run(execution, input.discussionId !== undefined);
      const receipt = { requestId, discussionId, sourceSpaceId: input.sourceSpaceId, sourceSessionId, ...(sourceDiscussionId ? { sourceDiscussionId } : {}), targetSpaceId: input.targetSpaceId,
        ...(controller.signal.aborted ? { status: "cancelled" as const, text: "Space request was cancelled" } : result) };
      await deps.onFinish?.(receipt);
      return receipt;
    } catch (error) {
      await deps.onFinish?.({ requestId, discussionId, sourceSpaceId: input.sourceSpaceId, sourceSessionId, targetSpaceId: input.targetSpaceId,
        status: controller.signal.aborted ? "cancelled" : "failed", text: "Space request failed" });
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      active.delete(key);
      finish();
    }
  };

  const history = async (spaceId: string, discussionId: string) => {
    if (!isSpaceId(spaceId) || !validDiscussionId(discussionId)) throw invalid();
    checkOpen(spaceId);
    await requireSpace(spaceId);
    checkOpen(spaceId);
    if (active.has(`${spaceId}/${discussionId}`)) throw new SpaceCommunicationError("BUSY", "Discussion is processing a request");
    return deps.runner.history(spaceId, discussionId);
  };
  const pauseSpace = (spaceId: string) => {
    paused.set(spaceId, (paused.get(spaceId) ?? 0) + 1);
    const runs = [...active.values()].filter((run) => run.sourceSpaceId === spaceId || run.targetSpaceId === spaceId);
    for (const run of runs) run.controller.abort();
    let resumed = false;
    return { stopped: Promise.all(runs.map((run) => run.done)), resume: () => {
      if (resumed) return;
      resumed = true;
      const count = (paused.get(spaceId) ?? 1) - 1;
      if (count) paused.set(spaceId, count); else paused.delete(spaceId);
    } };
  };
  const close = async () => {
    closed = true;
    const runs = [...active.values()];
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((run) => run.done));
  };
  return { listSpaces, request, history, pauseSpace, removeDiscussions: deps.runner.removeDiscussions, close };
};
export type SpaceCommunication = ReturnType<typeof createSpaceCommunication>;
