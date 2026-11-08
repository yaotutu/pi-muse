import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type Args = {
  baseUrl: string;
  tokenFile: string;
  contextFile: string;
  phase: "record" | "verify";
};

type Context = {
  sessionId: string;
  piSessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  commentId: string;
  revision: string;
  messageCount: number;
  eventCount: number;
};

type Feedback = {
  reaction: "like" | "dislike" | null;
  comments: Array<{ id: string; text: string; createdAt: string; updatedAt: string }>;
};

type Event =
  | { type: "reaction_changed"; messageId: string; from: "like" | "dislike" | null; to: "like" | "dislike" | null }
  | { type: "comment_added"; messageId: string; text: string }
  | { type: "comment_edited"; messageId: string; fromText: string; toText: string }
  | { type: "comment_deleted"; messageId: string; text: string };

const fail = (message: string): never => {
  throw new Error(message);
};

const parseArgs = (): Args => {
  const values = new Map<string, string>();
  let allowLive = false;
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--allow-live") {
      if (allowLive) fail("Duplicate --allow-live");
      allowLive = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[++index];
      if (!value || value.startsWith("--") || values.has(key)) fail(`Invalid or duplicate option: --${key}`);
      values.set(key, value);
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }
  if (!allowLive) fail("Explicit --allow-live is required");
  const baseUrl = values.get("base-url")!;
  const tokenFile = values.get("token-file")!;
  const contextFile = values.get("context-file")!;
  if (!baseUrl) fail("Explicit --base-url is required");
  if (!tokenFile) fail("Explicit --token-file is required");
  if (!contextFile) fail("Explicit --context-file is required");
  const phase = values.get("phase") ?? "record";
  const url = new URL(baseUrl);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username || url.password || url.search || url.hash
  ) fail("Invalid --base-url");
  if (phase !== "record" && phase !== "verify") fail("--phase must be record or verify");
  values.delete("base-url");
  values.delete("token-file");
  values.delete("context-file");
  values.delete("phase");
  if (values.size) fail(`Unknown option: --${[...values.keys()][0]}`);
  return { baseUrl: baseUrl.replace(/\/$/, ""), tokenFile, contextFile, phase: phase as Args["phase"] };
};

const args = parseArgs();
const token = (await readFile(args.tokenFile, "utf8")).trim();
if (!token) fail("Token file is empty");
let createdSessionId: string | undefined;

const api = async (
  path: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<{ status: number; body: unknown; text: string }> => {
  const response = await fetch(`${args.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, text };
};

const expectStatus = async (label: string, status: number, expected: number, body?: unknown) => {
  if (status !== expected) {
    const detail = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body);
    fail(`${label}: expected HTTP ${expected}, got ${status}: ${detail}`);
  }
  console.log(`[PASS] ${label}`);
};

const feedbackPath = (sessionId: string, messageId: string, suffix = "") =>
  `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/feedback${suffix}`;

const conversation = async (sessionId: string, requirePiSessionId = true) => {
  const result = await api(`/api/conversation?sessionId=${encodeURIComponent(sessionId)}`);
  await expectStatus(`GET conversation ${sessionId}`, result.status, 200, result.body);
  const body = result.body as {
    piSessionId: string | null;
    revision: string;
    messages: Array<{
      id: string;
      role: string;
      metadata?: { source: string | null; feedbackAvailable: boolean };
      feedback?: Feedback;
    }>;
  };
  if (requirePiSessionId && !body.piSessionId) fail(`Agent ${sessionId} has no session`);
  return body;
};

const runModel = async (sessionId: string, prompt: string, ids: { runId: string; messageId: string }) => {
  const before = await conversation(sessionId, false);
  const result = await api("/api/conversation/run", {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      runId: ids.runId,
      expectedRevision: before.revision,
      message: { id: ids.messageId, content: prompt },
    }),
  }, 300_000);
  await expectStatus(`real model run ${ids.runId}`, result.status, 200, result.body);
  const events = result.text.split("\n\n").flatMap((frame) =>
    frame.split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; messageId?: string }),
  );
  if (!events.some((event) => event.type === "RUN_FINISHED")) fail(`Model run ${ids.runId} did not finish`);
  const after = await conversation(sessionId);
  if (after.messages.length <= before.messages.length) fail("Real model run did not persist messages");
  console.log(`[PASS] real model persisted ${after.messages.length - before.messages.length} messages`);
  return after;
};

const assertAssistantAudit = (events: Event[], messageId: string) => {
  if (events.some((event) => event.messageId !== messageId)) fail("Raw events leaked another message target");
  if (events.map((event) => event.type).join(",") !==
    "reaction_changed,reaction_changed,reaction_changed,comment_added,comment_added,comment_edited,comment_deleted")
    fail("Raw assistant event sequence is incorrect");
  const reactions = events.filter((event): event is Extract<Event, { type: "reaction_changed" }> => event.type === "reaction_changed");
  if (
    JSON.stringify(reactions.map((event) => [event.from, event.to])) !==
    JSON.stringify([[null, "like"], ["like", "dislike"], ["dislike", null]])
  ) fail("Raw reaction transitions are incorrect");
  const added = events.filter((event): event is Extract<Event, { type: "comment_added" }> => event.type === "comment_added");
  if (added.map((event) => event.text).join("\n") !== "live comment one\nlive comment two")
    fail("Raw added comment text is incorrect");
  const edited = events.find((event): event is Extract<Event, { type: "comment_edited" }> => event.type === "comment_edited");
  if (edited?.fromText !== "live comment one" || edited.toText !== "live comment edited")
    fail("Raw edited comment old/new text is incorrect");
  const deleted = events.find((event): event is Extract<Event, { type: "comment_deleted" }> => event.type === "comment_deleted");
  if (deleted?.text !== "live comment two") fail("Raw deleted comment text is incorrect");
};

const setReaction = async (label: string, sessionId: string, piSessionId: string, messageId: string, reaction: "like" | "dislike" | null) => {
  const result = await api(feedbackPath(sessionId, messageId, "/reaction"), {
    method: "PUT",
    body: JSON.stringify({ piSessionId, reaction }),
  });
  await expectStatus(`${label} reaction ${reaction ?? "none"}`, result.status, 200, result.body);
  const feedback = result.body as Feedback;
  if (feedback.reaction !== reaction) fail(`${label} reaction response mismatch`);
};

const addComment = async (sessionId: string, piSessionId: string, messageId: string, text: string) => {
  const result = await api(feedbackPath(sessionId, messageId, "/comments"), {
    method: "POST",
    body: JSON.stringify({ piSessionId, text }),
  });
  await expectStatus(`add comment ${text}`, result.status, 200, result.body);
  return (result.body as Feedback).comments.at(-1)!;
};

const writeContext = async (context: Context) => {
  await mkdir(dirname(args.contextFile), { recursive: true, mode: 0o700 });
  await writeFile(args.contextFile, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
  console.log(`[PASS] wrote safe restart context ${args.contextFile}`);
};

try {
  if (args.phase === "record") {
    const stamp = Date.now();
    const created = await api("/api/sessions", {method:"POST",body:JSON.stringify({title:"Message feedback live acceptance"})});
    if(created.status!==200) fail("Session creation failed");
    const sessionId = (created.body as {session:{id:string}}).session.id;
    createdSessionId = sessionId;
    const userMessageId = `feedback-user-${stamp}`;
    const runId = `feedback-run-${stamp}-${randomUUID()}`;
    const first = await runModel(sessionId, "请直接简短回复 LIVE OK，不要调用工具。", { runId, messageId: userMessageId });
    const user = first.messages.find((message) => message.id === userMessageId && message.role === "user");
    const assistant = first.messages.find((message) => message.role === "assistant" && message.metadata?.source === "chat");
    if (!user?.metadata || !user.feedback || !assistant?.metadata || !assistant.feedback)
      fail("Real model history is missing required message metadata/feedback");
    const userMessage = user!;
    const assistantMessage = assistant!;
    if (userMessage.metadata!.source !== "chat" || assistantMessage.metadata!.source !== "chat" || !assistantMessage.metadata!.feedbackAvailable)
      fail("Real chat source or availability is incorrect");

    await setReaction("user", sessionId, first.piSessionId!, userMessage.id, "like");
    await setReaction("user", sessionId, first.piSessionId!, userMessage.id, "dislike");
    await setReaction("user", sessionId, first.piSessionId!, userMessage.id, null);
    await setReaction("assistant", sessionId, first.piSessionId!, assistantMessage.id, "like");
    await setReaction("assistant", sessionId, first.piSessionId!, assistantMessage.id, "dislike");
    await setReaction("assistant", sessionId, first.piSessionId!, assistantMessage.id, null);

    const firstComment = await addComment(sessionId, first.piSessionId!, assistantMessage.id, " live comment one ");
    const secondComment = await addComment(sessionId, first.piSessionId!, assistantMessage.id, " live comment two ");
    if (firstComment.text !== "live comment one" || secondComment.text !== "live comment two")
      fail("Server did not trim and persist multiple comments");

    const edit = await api(`${feedbackPath(sessionId, assistantMessage.id, `/comments/${firstComment.id}`)}`, {
      method: "PATCH",
      body: JSON.stringify({ piSessionId: first.piSessionId, text: "live comment edited" }),
    });
    await expectStatus("edit comment", edit.status, 200, edit.body);
    const edited = (edit.body as Feedback).comments.find((comment) => comment.id === firstComment.id)!;
    if (edited.text !== "live comment edited" || edited.updatedAt <= edited.createdAt)
      fail("Edited comment text or updatedAt is incorrect");

    const remove = await api(`${feedbackPath(sessionId, assistantMessage.id, `/comments/${secondComment.id}`)}?piSessionId=${encodeURIComponent(first.piSessionId!)}`, {
      method: "DELETE",
    });
    await expectStatus("delete comment", remove.status, 200, remove.body);
    if ((remove.body as Feedback).comments.some((comment) => comment.id === secondComment.id)) fail("Deleted comment remained current");

    const eventsResult = await api(`${feedbackPath(sessionId, assistantMessage.id, "/events")}?piSessionId=${encodeURIComponent(first.piSessionId!)}`);
    await expectStatus("read message-scoped raw events", eventsResult.status, 200, eventsResult.body);
    const events = (eventsResult.body as { events: Event[] }).events;
    assertAssistantAudit(events, assistantMessage.id);

    const afterFeedback = await conversation(sessionId);
    if (afterFeedback.revision !== first.revision || afterFeedback.messages.length !== first.messages.length)
      fail("Feedback changed PI revision or message count");

    await expectStatus(
      "unauthorized feedback is rejected",
      (await fetch(args.baseUrl + feedbackPath(sessionId, assistantMessage.id), { signal: AbortSignal.timeout(30_000) })).status,
      401,
    );
    const invalid = await api(feedbackPath(sessionId, assistantMessage.id, "/reaction"), {
      method: "PUT",
      body: JSON.stringify({ piSessionId: first.piSessionId, reaction: "meh" }),
    });
    await expectStatus("invalid reaction is rejected", invalid.status, 400, invalid.body);
    const missingMessage = await api(`${feedbackPath(sessionId, "missing-message")}?piSessionId=${encodeURIComponent(first.piSessionId!)}`);
    await expectStatus("missing message is rejected", missingMessage.status, 404, missingMessage.body);
    const missingAgent = await api(`${feedbackPath("00000000-0000-4000-8000-000000000099", "missing")}?piSessionId=${encodeURIComponent(first.piSessionId!)}`);
    await expectStatus("missing agent is rejected", missingAgent.status, 404, missingAgent.body);
    const crossAgentConflict = await api(`${feedbackPath("main", assistantMessage.id)}?piSessionId=${encodeURIComponent(first.piSessionId!)}`);
    await expectStatus("cross-agent session is rejected", crossAgentConflict.status, 409, crossAgentConflict.body);
    const localMain = await conversation("main", false);
    if (localMain.piSessionId) {
      const crossAgentTarget = await api(`${feedbackPath("main", assistantMessage.id)}?piSessionId=${encodeURIComponent(localMain.piSessionId)}`);
      await expectStatus("cross-agent message is rejected", crossAgentTarget.status, 404, crossAgentTarget.body);
    } else {
      const wrongTarget = await api(`${feedbackPath(sessionId, "missing-cross-target")}?piSessionId=${encodeURIComponent(first.piSessionId!)}`);
      await expectStatus("missing message fallback is rejected", wrongTarget.status, 404, wrongTarget.body);
    }

    await writeContext({
      sessionId,
      piSessionId: first.piSessionId!,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      commentId: firstComment.id,
      revision: afterFeedback.revision,
      messageCount: afterFeedback.messages.length,
      eventCount: events.length,
    });
    console.log("[PASS] record phase complete; restart backend then run --phase verify");
  } else {
    const context = JSON.parse(await readFile(args.contextFile, "utf8")) as Context;
    const restarted = await conversation(context.sessionId);
    if (restarted.piSessionId !== context.piSessionId || restarted.revision !== context.revision || restarted.messages.length !== context.messageCount)
      fail("Restart changed session identity, PI revision, or persisted message count");
    const assistant = restarted.messages.find((message) => message.id === context.assistantMessageId);
    const comment = assistant?.feedback?.comments.find((item) => item.id === context.commentId);
    if (!comment || comment.text !== "live comment edited") fail("Restart lost persisted feedback");

    const eventsResult = await api(`${feedbackPath(context.sessionId, context.assistantMessageId, "/events")}?piSessionId=${encodeURIComponent(context.piSessionId)}`);
    await expectStatus("read events after restart", eventsResult.status, 200, eventsResult.body);
    const events = (eventsResult.body as { events: Event[] }).events;
    if (events.length !== context.eventCount)
      fail("Restart changed or leaked raw feedback events");
    assertAssistantAudit(events, context.assistantMessageId);

    const stamp = Date.now();
    await runModel(context.sessionId, "请再直接简短回复 LIVE VERIFY OK，不要调用工具。", {
      runId: `feedback-verify-${stamp}-${randomUUID()}`,
      messageId: `feedback-verify-user-${stamp}`,
    });

    const reset = await api(`/api/sessions/${encodeURIComponent(context.sessionId)}/reset`, {
      method: "POST",
      body: JSON.stringify({ clearSchedules: false }),
    });
    await expectStatus("reset live test agent", reset.status, 200, reset.body);
    const newPiSessionId = (await conversation(context.sessionId)).piSessionId!;
    if (newPiSessionId === context.piSessionId) fail("Reset did not change piSessionId");
    const oldSession = await api(feedbackPath(context.sessionId, context.assistantMessageId, "/reaction"), {
      method: "PUT",
      body: JSON.stringify({ piSessionId: context.piSessionId, reaction: "like" }),
    });
    await expectStatus("old session is rejected after reset", oldSession.status, 409, oldSession.body);

    const deleted = await api(`/api/sessions/${encodeURIComponent(context.sessionId)}`, { method: "DELETE" });
    await expectStatus("delete live test agent", deleted.status, 200, deleted.body);
    const revived = await api(`${feedbackPath(context.sessionId, context.assistantMessageId)}?piSessionId=${encodeURIComponent(newPiSessionId)}`);
    await expectStatus("deleted agent feedback cannot revive", revived.status, 404, revived.body);
    console.log("[PASS] verify phase complete");
  }
} catch (error) {
  if (createdSessionId && args.phase === "record") {
    await api(`/api/sessions/${encodeURIComponent(createdSessionId)}`, { method: "DELETE" }).catch(() => undefined);
  }
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
