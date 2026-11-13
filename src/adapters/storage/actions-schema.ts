import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import type { SqliteModule } from "./sqlite-modules.js";
import type {
  ActionKind,
  ActionStatus,
  ApprovalExecutionStatus,
  PendingAction,
} from "../../features/actions/types.js";

/**
 * 审批记录（文件 write/edit 审批与执行回执）的 SQLite 表结构与行映射。
 *
 * 为什么把状态机写进数据库约束：审批记录同时承载"人的决定"（approved/denied）
 * 与"执行事实"（execution），两者一旦被错误组合就会把授权读成执行成功。
 * 这里把 readActionsDocument 的每条状态机规则逐条翻成 CHECK，非法组合在写入
 * 那一刻就被拒绝，不会落库后再被读路径发现。
 *
 * 时间统一为 UTC ISO 8601（毫秒 + Z），与 new Date().toISOString() 完全一致。
 * 规范性格由 strftime('%Y-%m-%dT%H:%M:%fZ', 列) = 列 判定：只有能被 SQLite
 * 解析、且回写后逐字节相同的时刻才算规范时刻；只有日期、"+00:00" 偏移、6 位
 * 微秒都会被拒绝（与 toISOString() 的规范输出不兼容）。
 *
 * 执行事实独立于人的决定：approved 只代表授权，执行成功与否由 execution_status
 * 表达；execution_status='unknown' 表示结果未明（finished_at 必须为空），
 * 不允许被当成成功，也不允许自动重放。
 *
 * payload 的"值必须全是字符串"由仓储边界强制（见 encodePayload）：SQLite 禁止在
 * CHECK 约束里使用子查询，而"逐值检查 json_each"必须用子查询，所以数据库只保证
 * payload_json 是合法 JSON 对象，取值类型在写入前就被拒绝。
 */

/** 审批记录的模块标识与结构版本；版本变化必须显式提供新 DDL，不做自动迁移。 */
export const ACTIONS_MODULE_ID = "actions";
export const ACTIONS_MODULE_VERSION = 1;

/**
 * 规范 ISO 8601 时刻（UTC、毫秒、Z）判定：列值必须与自身回写结果逐字节相同。
 * strftime 对无法解析的输入返回 NULL，而 CHECK 约束里的 NULL 等于"通过"，所以必须
 * 显式排除 NULL，否则 "not-a-date" 这类坏值会被放行。
 */
const isCanonicalInstant = (column: string): string =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) = ${column}`;

const ACTIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT,
  run_id TEXT,
  tool_call_id TEXT,
  subagent_id TEXT,
  activity_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('file_write', 'file_edit')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  resolved_at TEXT,
  execution_status TEXT CHECK (execution_status IN ('running', 'succeeded', 'failed', 'cancelled', 'unknown')),
  execution_started_at TEXT,
  execution_finished_at TEXT,
  execution_result TEXT,
  CONSTRAINT actions_created_at_iso CHECK (${isCanonicalInstant("created_at")}),
  CONSTRAINT actions_expires_at_iso CHECK (${isCanonicalInstant("expires_at")}),
  CONSTRAINT actions_pending_open CHECK (
    status <> 'pending' OR (decided_at IS NULL AND resolved_at IS NULL)
  ),
  CONSTRAINT actions_resolved_at CHECK (
    (status = 'pending' AND resolved_at IS NULL)
    OR (status <> 'pending' AND resolved_at IS NOT NULL AND ${isCanonicalInstant("resolved_at")})
  ),
  CONSTRAINT actions_decided_at CHECK (
    (status IN ('approved', 'denied') AND decided_at IS NOT NULL AND ${isCanonicalInstant("decided_at")})
    OR (status NOT IN ('approved', 'denied') AND decided_at IS NULL)
  ),
  CONSTRAINT actions_execution_scope CHECK (
    (execution_status IS NULL AND execution_started_at IS NULL AND execution_finished_at IS NULL AND execution_result IS NULL)
    OR (execution_status IS NOT NULL AND execution_started_at IS NOT NULL AND status = 'approved')
  ),
  CONSTRAINT actions_execution_started_at_iso CHECK (
    execution_started_at IS NULL OR ${isCanonicalInstant("execution_started_at")}
  ),
  CONSTRAINT actions_execution_finished CHECK (
    CASE execution_status
      WHEN 'running' THEN execution_finished_at IS NULL AND execution_result IS NULL
      WHEN 'unknown' THEN execution_finished_at IS NULL
      WHEN 'succeeded' THEN execution_finished_at IS NOT NULL AND ${isCanonicalInstant("execution_finished_at")}
      WHEN 'failed' THEN execution_finished_at IS NOT NULL AND ${isCanonicalInstant("execution_finished_at")}
      WHEN 'cancelled' THEN execution_finished_at IS NOT NULL AND ${isCanonicalInstant("execution_finished_at")}
      ELSE execution_status IS NULL
    END
  ),
  CONSTRAINT actions_payload_json CHECK (
    json_valid(payload_json) AND json_type(payload_json) = 'object'
  )
)`;

export const actionsModule: SqliteModule = {
  id: ACTIONS_MODULE_ID,
  version: ACTIONS_MODULE_VERSION,
  tables: ["actions"],
  ddl: [ACTIONS_TABLE_DDL],
};

/** 表内持久列；id 是主键，position 只在顺序变化时写入。 */
export type ActionRow = {
  id: string;
  session_id: string | null;
  run_id: string | null;
  tool_call_id: string | null;
  subagent_id: string | null;
  activity_id: string | null;
  kind: ActionKind;
  status: ActionStatus;
  title: string;
  payload_json: string;
  revision: number;
  position: number;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  resolved_at: string | null;
  execution_status: ApprovalExecutionStatus | null;
  execution_started_at: string | null;
  execution_finished_at: string | null;
  execution_result: string | null;
};

const PERSISTED_COLUMNS = [
  "id", "session_id", "run_id", "tool_call_id", "subagent_id", "activity_id",
  "kind", "status", "title", "payload_json", "revision", "position",
  "created_at", "expires_at", "decided_at", "resolved_at",
  "execution_status", "execution_started_at", "execution_finished_at", "execution_result",
] as const;

const INSERT_STATEMENT = `INSERT INTO actions (${PERSISTED_COLUMNS.join(", ")}) VALUES (${PERSISTED_COLUMNS.map(() => "?").join(", ")})`;

/**
 * payload 只允许字符串键值；按写入时的键序序列化，读回保持同一键序，
 * 与旧 JSON 文档里 payload 对象的形状完全一致。
 */
export const encodePayload = (payload: Record<string, string>): string => {
  const entries = Object.entries(payload ?? {});
  for (const [key, value] of entries) {
    if (typeof key !== "string" || typeof value !== "string") {
      throw new Error("Approval payload must be a string map");
    }
  }
  return JSON.stringify(Object.fromEntries(entries));
};

const decodePayload = (raw: string): Record<string, string> => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid approval payload");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid approval payload");
  }
  return value as Record<string, string>;
};

/** 行 → 领域对象；execution 只在确实观察到执行事实时出现（与旧文档同形）。 */
export const actionFromRow = (row: ActionRow): PendingAction => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  payload: decodePayload(row.payload_json),
  status: row.status,
  revision: row.revision,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  resolvedAt: row.resolved_at,
  decidedAt: row.decided_at,
  sessionId: row.session_id,
  runId: row.run_id,
  toolCallId: row.tool_call_id,
  subagentId: row.subagent_id,
  activityId: row.activity_id,
  ...(row.execution_status === null ? {} : {
    execution: {
      status: row.execution_status,
      startedAt: row.execution_started_at as string,
      finishedAt: row.execution_finished_at,
      result: row.execution_result,
    },
  }),
});

/** 按 position 保序读取全部审批记录；position 相同的行以 id 决胜，保证顺序稳定。 */
export const readActionRows = (managed: ManagedSqliteDatabase): ActionRow[] =>
  managed.database.prepare(`SELECT ${PERSISTED_COLUMNS.join(", ")} FROM actions ORDER BY position ASC, id ASC`).all() as ActionRow[];

/** 领域对象 → 持久列；position 由数组下标决定，保证读回顺序与写入顺序一致。 */
const projectColumns = (action: PendingAction, position: number): Record<string, string | number | null> => ({
  session_id: action.sessionId ?? null,
  run_id: action.runId ?? null,
  tool_call_id: action.toolCallId ?? null,
  subagent_id: action.subagentId ?? null,
  activity_id: action.activityId ?? null,
  kind: action.kind,
  status: action.status,
  title: action.title,
  payload_json: encodePayload(action.payload),
  revision: action.revision,
  position,
  created_at: action.createdAt,
  expires_at: action.expiresAt,
  decided_at: action.decidedAt ?? null,
  resolved_at: action.resolvedAt ?? null,
  execution_status: action.execution?.status ?? null,
  execution_started_at: action.execution?.startedAt ?? null,
  execution_finished_at: action.execution?.finishedAt ?? null,
  execution_result: action.execution?.result ?? null,
});

/**
 * 行级 diff 提交：previous 是本次事务前读回的行，next 是业务回调产生的新聚合。
 * 只增删改发生变化的行与变化的列，不整表重写；删除只针对回调快照里出现过的行，
 * 快照之后由其它写入方新增的行不会被抹掉。
 */
export const applyActionsDiff = (
  managed: ManagedSqliteDatabase,
  previous: readonly ActionRow[],
  next: readonly PendingAction[],
): void => {
  const database = managed.database;
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const nextIds = new Set(next.map((action) => action.id));
  for (const row of previous) {
    if (!nextIds.has(row.id)) database.prepare("DELETE FROM actions WHERE id = ?").run(row.id);
  }
  next.forEach((action, index) => {
    const columns = projectColumns(action, index);
    const old = previousById.get(action.id);
    if (!old) {
      database.prepare(INSERT_STATEMENT).run(
        action.id,
        columns.session_id, columns.run_id, columns.tool_call_id, columns.subagent_id, columns.activity_id,
        columns.kind, columns.status, columns.title, columns.payload_json, columns.revision, columns.position,
        columns.created_at, columns.expires_at, columns.decided_at, columns.resolved_at,
        columns.execution_status, columns.execution_started_at, columns.execution_finished_at, columns.execution_result,
      );
      return;
    }
    const previousColumns = old as unknown as Record<string, string | number | null>;
    const changed = PERSISTED_COLUMNS.filter((column) => column !== "id" && columns[column] !== previousColumns[column]);
    if (!changed.length) return;
    const assignments = changed.map((column) => `${column} = ?`).join(", ");
    database.prepare(`UPDATE actions SET ${assignments} WHERE id = ?`).run(
      ...changed.map((column) => columns[column]),
      action.id,
    );
  });
};
