import { z } from "zod";
import { isSessionId } from "../../features/conversation/session-id.js";
import { hasActiveFeedback, projectFeedback } from "../../features/messages/service.js";
import type {
  FeedbackTargetRole,
  MessageFeedbackDocument,
  MessageFeedbackEvent,
  MessageFeedbackFilter,
  MessageFeedbackStateRecord,
  MessageReaction,
} from "../../features/messages/types.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import { SQLITE_MODULE_LEDGER_TABLE, type SqliteModule } from "./sqlite-modules.js";

export const MESSAGE_FEEDBACK_SCHEMA_VERSION = 1;
export const MESSAGE_FEEDBACK_EVENTS_TABLE = "message_feedback_events";
export const MESSAGE_FEEDBACK_STATES_TABLE = "message_feedback_states";

const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const MESSAGE_FEEDBACK_DDL = [
  `CREATE TABLE IF NOT EXISTS ${MESSAGE_FEEDBACK_EVENTS_TABLE} (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    pi_session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    type TEXT NOT NULL CHECK (type IN ('reaction_changed', 'saved_changed', 'comment_added', 'comment_edited', 'comment_deleted')),
    from_reaction TEXT CHECK (from_reaction IN ('like', 'dislike')),
    to_reaction TEXT CHECK (to_reaction IN ('like', 'dislike')),
    from_saved INTEGER CHECK (from_saved IN (0, 1)),
    to_saved INTEGER CHECK (to_saved IN (0, 1)),
    comment_id TEXT,
    text TEXT,
    from_text TEXT,
    to_text TEXT,
    at TEXT NOT NULL CHECK (julianday(at) IS NOT NULL)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_message_feedback_events_scope ON ${MESSAGE_FEEDBACK_EVENTS_TABLE} (session_id, pi_session_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_message_feedback_events_message ON ${MESSAGE_FEEDBACK_EVENTS_TABLE} (session_id, pi_session_id, message_id, position)`,
  `CREATE TABLE IF NOT EXISTS ${MESSAGE_FEEDBACK_STATES_TABLE} (
    session_id TEXT NOT NULL,
    pi_session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    reaction TEXT CHECK (reaction IN ('like', 'dislike')),
    saved INTEGER NOT NULL CHECK (saved IN (0, 1)),
    comment_count INTEGER NOT NULL CHECK (comment_count >= 0),
    updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
    PRIMARY KEY (session_id, pi_session_id, message_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_message_feedback_states_saved ON ${MESSAGE_FEEDBACK_STATES_TABLE} (session_id, pi_session_id, saved, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_message_feedback_states_reaction ON ${MESSAGE_FEEDBACK_STATES_TABLE} (session_id, pi_session_id, reaction, updated_at DESC)`,
] as const;

const MESSAGE_FEEDBACK_TABLES = [
  MESSAGE_FEEDBACK_EVENTS_TABLE,
  MESSAGE_FEEDBACK_STATES_TABLE,
] as const;

export const messageFeedbackModule: SqliteModule = {
  id: "message_feedback",
  version: MESSAGE_FEEDBACK_SCHEMA_VERSION,
  tables: MESSAGE_FEEDBACK_TABLES,
  ddl: MESSAGE_FEEDBACK_DDL,
};

const isoTime = z.string().datetime();
const reactionEventSchema = z.strictObject({
  id: z.string().uuid(),
  type: z.literal("reaction_changed"),
  messageId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  from: z.enum(["like", "dislike"]).nullable(),
  to: z.enum(["like", "dislike"]).nullable(),
  at: isoTime,
});
const savedEventSchema = z.strictObject({
  id: z.string().uuid(),
  type: z.literal("saved_changed"),
  messageId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  from: z.boolean(),
  to: z.boolean(),
  at: isoTime,
});
const commentAddedSchema = z.strictObject({
  id: z.string().uuid(),
  type: z.literal("comment_added"),
  messageId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  commentId: z.string().uuid(),
  text: z.string().min(1).max(4000),
  at: isoTime,
});
const commentEditedSchema = z.strictObject({
  id: z.string().uuid(),
  type: z.literal("comment_edited"),
  messageId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  commentId: z.string().uuid(),
  fromText: z.string().min(1).max(4000),
  toText: z.string().min(1).max(4000),
  at: isoTime,
});
const commentDeletedSchema = z.strictObject({
  id: z.string().uuid(),
  type: z.literal("comment_deleted"),
  messageId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  commentId: z.string().uuid(),
  text: z.string().min(1).max(4000),
  at: isoTime,
});

export const messageFeedbackEventSchema = z.discriminatedUnion("type", [
  reactionEventSchema,
  savedEventSchema,
  commentAddedSchema,
  commentEditedSchema,
  commentDeletedSchema,
]);

export const messageFeedbackDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  events: z.array(messageFeedbackEventSchema),
});

export const parseMessageFeedbackDocument = (value: unknown, logicalScope = "message_feedback"): MessageFeedbackDocument => {
  const parsed = messageFeedbackDocumentSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid message feedback document: ${logicalScope}`);
  return parsed.data;
};

type EventRow = {
  id: string;
  position: number;
  session_id: string;
  pi_session_id: string;
  message_id: string;
  role: FeedbackTargetRole;
  type: MessageFeedbackEvent["type"];
  from_reaction: MessageReaction | null;
  to_reaction: MessageReaction | null;
  from_saved: number | null;
  to_saved: number | null;
  comment_id: string | null;
  text: string | null;
  from_text: string | null;
  to_text: string | null;
  at: string;
};

type StateRow = {
  session_id: string;
  pi_session_id: string;
  message_id: string;
  role: FeedbackTargetRole;
  reaction: MessageReaction | null;
  saved: number;
  comment_count: number;
  updated_at: string;
};

const tableExists = (managed: ManagedSqliteDatabase, table: string): boolean =>
  Boolean(managed.database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));

export const ensureMessageFeedbackModule = (managed: ManagedSqliteDatabase): void => {
  if (!tableExists(managed, SQLITE_MODULE_LEDGER_TABLE)) {
    throw new Error("Invalid main database: missing schema ledger; ensureSqliteModules must run before message feedback repository is created");
  }
  const registered = managed.database
    .prepare(`SELECT version FROM ${SQLITE_MODULE_LEDGER_TABLE} WHERE module = ?`)
    .get("message_feedback") as { version: number } | undefined;
  if (!registered) throw new Error("Invalid main database: module message_feedback is not registered");
  if (registered.version !== MESSAGE_FEEDBACK_SCHEMA_VERSION) {
    throw new Error(
      `Invalid main database: module message_feedback has version ${registered.version}, expected ${MESSAGE_FEEDBACK_SCHEMA_VERSION}`,
    );
  }
  for (const table of MESSAGE_FEEDBACK_TABLES) {
    if (!tableExists(managed, table)) {
      throw new Error(`Invalid main database: module message_feedback is missing table ${table}`);
    }
  }
};

const assertScopeIds = (sessionId: string, piSessionId: string): void => {
  if (!isSessionId(sessionId)) throw new Error("Invalid sessionId");
  if (!PI_SESSION_ID_PATTERN.test(piSessionId)) throw new Error("Invalid piSessionId");
};

const parseEventRow = (row: EventRow, logicalScope: string): MessageFeedbackEvent => {
  let candidate: unknown;
  switch (row.type) {
    case "reaction_changed":
      if (row.from_saved !== null || row.to_saved !== null || row.comment_id !== null ||
        row.text !== null || row.from_text !== null || row.to_text !== null) {
        throw new Error(`Invalid message feedback row: ${logicalScope}`);
      }
      candidate = {
        id: row.id,
        type: "reaction_changed",
        messageId: row.message_id,
        role: row.role,
        from: row.from_reaction,
        to: row.to_reaction,
        at: row.at,
      };
      break;
    case "saved_changed":
      if (row.from_reaction !== null || row.to_reaction !== null ||
        (row.from_saved !== 0 && row.from_saved !== 1) ||
        (row.to_saved !== 0 && row.to_saved !== 1) ||
        row.comment_id !== null || row.text !== null || row.from_text !== null || row.to_text !== null) {
        throw new Error(`Invalid message feedback row: ${logicalScope}`);
      }
      candidate = {
        id: row.id,
        type: "saved_changed",
        messageId: row.message_id,
        role: row.role,
        from: row.from_saved === 1,
        to: row.to_saved === 1,
        at: row.at,
      };
      break;
    case "comment_added":
      if (row.from_reaction !== null || row.to_reaction !== null || row.from_saved !== null ||
        row.to_saved !== null || row.from_text !== null || row.to_text !== null) {
        throw new Error(`Invalid message feedback row: ${logicalScope}`);
      }
      candidate = {
        id: row.id,
        type: "comment_added",
        messageId: row.message_id,
        role: row.role,
        commentId: row.comment_id,
        text: row.text,
        at: row.at,
      };
      break;
    case "comment_edited":
      if (row.from_reaction !== null || row.to_reaction !== null || row.from_saved !== null ||
        row.to_saved !== null || row.text !== null) {
        throw new Error(`Invalid message feedback row: ${logicalScope}`);
      }
      candidate = {
        id: row.id,
        type: "comment_edited",
        messageId: row.message_id,
        role: row.role,
        commentId: row.comment_id,
        fromText: row.from_text,
        toText: row.to_text,
        at: row.at,
      };
      break;
    case "comment_deleted":
      if (row.from_reaction !== null || row.to_reaction !== null || row.from_saved !== null ||
        row.to_saved !== null || row.from_text !== null || row.to_text !== null) {
        throw new Error(`Invalid message feedback row: ${logicalScope}`);
      }
      candidate = {
        id: row.id,
        type: "comment_deleted",
        messageId: row.message_id,
        role: row.role,
        commentId: row.comment_id,
        text: row.text,
        at: row.at,
      };
      break;
    default:
      throw new Error(`Invalid message feedback row: ${logicalScope}`);
  }
  const parsed = messageFeedbackEventSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`Invalid message feedback document: ${logicalScope}`);
  return parsed.data;
};

const insertEventStatement = (managed: ManagedSqliteDatabase) =>
  managed.database.prepare(
    `INSERT INTO ${MESSAGE_FEEDBACK_EVENTS_TABLE} (
      id, position, session_id, pi_session_id, message_id, role, type,
      from_reaction, to_reaction, from_saved, to_saved, comment_id, text, from_text, to_text, at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

const insertEventRow = (
  statement: ReturnType<ManagedSqliteDatabase["database"]["prepare"]>,
  sessionId: string,
  piSessionId: string,
  position: number,
  event: MessageFeedbackEvent,
): void => {
  statement.run(
    event.id,
    position,
    sessionId,
    piSessionId,
    event.messageId,
    event.role,
    event.type,
    event.type === "reaction_changed" ? event.from : null,
    event.type === "reaction_changed" ? event.to : null,
    event.type === "saved_changed" ? (event.from ? 1 : 0) : null,
    event.type === "saved_changed" ? (event.to ? 1 : 0) : null,
    event.type === "comment_added" || event.type === "comment_edited" || event.type === "comment_deleted" ? event.commentId : null,
    event.type === "comment_added" || event.type === "comment_deleted" ? event.text : null,
    event.type === "comment_edited" ? event.fromText : null,
    event.type === "comment_edited" ? event.toText : null,
    event.at,
  );
};

export const readMessageFeedbackDocument = (
  managed: ManagedSqliteDatabase,
  sessionId: string,
  piSessionId: string,
): MessageFeedbackDocument => {
  assertScopeIds(sessionId, piSessionId);
  const logicalScope = `${sessionId}/${piSessionId}`;
  const rows = managed.database
    .prepare(`SELECT * FROM ${MESSAGE_FEEDBACK_EVENTS_TABLE} WHERE session_id = ? AND pi_session_id = ? ORDER BY position ASC`)
    .all(sessionId, piSessionId) as EventRow[];
  return {
    schemaVersion: 1,
    events: rows.map((row) => parseEventRow(row, logicalScope)),
  };
};

const eventsMatch = (left: MessageFeedbackEvent, right: MessageFeedbackEvent): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** 同步提交该作用域的反馈事件增量与消息级状态索引表，必须在短事务内调用。 */
export const applyMessageFeedbackDocument = (
  managed: ManagedSqliteDatabase,
  sessionId: string,
  piSessionId: string,
  previous: MessageFeedbackDocument,
  nextRaw: MessageFeedbackDocument,
): void => {
  assertScopeIds(sessionId, piSessionId);
  const logicalScope = `${sessionId}/${piSessionId}`;
  const next = parseMessageFeedbackDocument(nextRaw, logicalScope);
  const appendOnly =
    next.events.length >= previous.events.length &&
    previous.events.every((event, index) => eventsMatch(event, next.events[index]!));

  const insert = insertEventStatement(managed);
  if (appendOnly) {
    if (next.events.length > previous.events.length) {
      let nextPos =
        Number(
          (managed.database.prepare(`SELECT COALESCE(MAX(position), 0) AS max_pos FROM ${MESSAGE_FEEDBACK_EVENTS_TABLE}`).get() as { max_pos: number })
            .max_pos,
        ) + 1;
      for (const event of next.events.slice(previous.events.length)) {
        insertEventRow(insert, sessionId, piSessionId, nextPos++, event);
      }
    }
  } else {
    managed.database
      .prepare(`DELETE FROM ${MESSAGE_FEEDBACK_EVENTS_TABLE} WHERE session_id = ? AND pi_session_id = ?`)
      .run(sessionId, piSessionId);
    let nextPos =
      Number(
        (managed.database.prepare(`SELECT COALESCE(MAX(position), 0) AS max_pos FROM ${MESSAGE_FEEDBACK_EVENTS_TABLE}`).get() as { max_pos: number })
          .max_pos,
      ) + 1;
    for (const event of next.events) {
      insertEventRow(insert, sessionId, piSessionId, nextPos++, event);
    }
  }

  const affectedMessages = new Set<string>();
  if (appendOnly) {
    for (const event of next.events.slice(previous.events.length)) {
      affectedMessages.add(event.messageId);
    }
  } else {
    for (const event of previous.events) affectedMessages.add(event.messageId);
    for (const event of next.events) affectedMessages.add(event.messageId);
  }
  if (!affectedMessages.size) return;

  const metaByMessage = new Map<string, { role: FeedbackTargetRole; updatedAt: string }>();
  for (const event of next.events) {
    if (affectedMessages.has(event.messageId)) {
      metaByMessage.set(event.messageId, { role: event.role, updatedAt: event.at });
    }
  }

  const upsertState = managed.database.prepare(
    `INSERT INTO ${MESSAGE_FEEDBACK_STATES_TABLE} (
      session_id, pi_session_id, message_id, role, reaction, saved, comment_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, pi_session_id, message_id) DO UPDATE SET
      role = excluded.role,
      reaction = excluded.reaction,
      saved = excluded.saved,
      comment_count = excluded.comment_count,
      updated_at = excluded.updated_at`,
  );
  const deleteState = managed.database.prepare(
    `DELETE FROM ${MESSAGE_FEEDBACK_STATES_TABLE} WHERE session_id = ? AND pi_session_id = ? AND message_id = ?`,
  );

  for (const messageId of affectedMessages) {
    const projected = projectFeedback(next, messageId);
    const meta = metaByMessage.get(messageId);
    if (!meta || !hasActiveFeedback(projected)) {
      deleteState.run(sessionId, piSessionId, messageId);
      continue;
    }
    upsertState.run(
      sessionId,
      piSessionId,
      messageId,
      meta.role,
      projected.reaction,
      projected.saved ? 1 : 0,
      projected.comments.length,
      meta.updatedAt,
    );
  }
};

export const listMessageFeedbackStates = (
  managed: ManagedSqliteDatabase,
  sessionId: string,
  piSessionId: string,
  filter?: MessageFeedbackFilter,
): MessageFeedbackStateRecord[] => {
  assertScopeIds(sessionId, piSessionId);
  const clauses = ["session_id = ?", "pi_session_id = ?"];
  const params: Array<string | number> = [sessionId, piSessionId];
  if (filter?.saved !== undefined) {
    clauses.push("saved = ?");
    params.push(filter.saved ? 1 : 0);
  }
  if (filter?.reaction !== undefined) {
    clauses.push("reaction = ?");
    params.push(filter.reaction);
  }
  const rows = managed.database
    .prepare(
      `SELECT session_id, pi_session_id, message_id, role, reaction, saved, comment_count, updated_at
       FROM ${MESSAGE_FEEDBACK_STATES_TABLE}
       WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC, message_id ASC`,
    )
    .all(...params) as StateRow[];
  return rows.map((row) => ({
    messageId: row.message_id,
    role: row.role,
    reaction: row.reaction,
    saved: row.saved === 1,
    commentCount: row.comment_count,
    updatedAt: row.updated_at,
  }));
};

export const removeSessionMessageFeedback = (
  managed: ManagedSqliteDatabase,
  sessionId: string,
): void => {
  if (!isSessionId(sessionId)) throw new Error("Invalid sessionId");
  managed.database
    .prepare(`DELETE FROM ${MESSAGE_FEEDBACK_STATES_TABLE} WHERE session_id = ?`)
    .run(sessionId);
  managed.database
    .prepare(`DELETE FROM ${MESSAGE_FEEDBACK_EVENTS_TABLE} WHERE session_id = ?`)
    .run(sessionId);
};

export const validateAllMessageFeedback = (managed: ManagedSqliteDatabase): void => {
  ensureMessageFeedbackModule(managed);
  const events = managed.database
    .prepare(`SELECT * FROM ${MESSAGE_FEEDBACK_EVENTS_TABLE} ORDER BY position ASC`)
    .all() as EventRow[];
  for (const row of events) {
    assertScopeIds(row.session_id, row.pi_session_id);
    parseEventRow(row, `${row.session_id}/${row.pi_session_id}`);
  }
  const states = managed.database
    .prepare(`SELECT * FROM ${MESSAGE_FEEDBACK_STATES_TABLE}`)
    .all() as StateRow[];
  for (const row of states) {
    assertScopeIds(row.session_id, row.pi_session_id);
    if (
      !row.message_id ||
      (row.role !== "user" && row.role !== "assistant") ||
      (row.reaction !== null && row.reaction !== "like" && row.reaction !== "dislike") ||
      (row.saved !== 0 && row.saved !== 1) ||
      !Number.isInteger(row.comment_count) ||
      row.comment_count < 0 ||
      !isoTime.safeParse(row.updated_at).success
    ) {
      throw new Error(`Invalid message feedback state row: ${row.session_id}/${row.pi_session_id}/${row.message_id}`);
    }
  }
};
