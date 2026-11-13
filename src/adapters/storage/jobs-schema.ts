import { InvalidDocumentError } from "./document-schemas.js";
import type { SqliteModule } from "./sqlite-modules.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import { isIsoWithTimezone, isStrictDailyTime } from "../../features/jobs/schedule-calculator.js";
import type { Job, JobControlAction } from "../../features/jobs/types.js";

/**
 * main.sqlite 的 jobs 模块：定时任务的持久化事实。
 *
 * 迁移背景：定时任务原存在 DATA_DIR/jobs.json（裸数组），本次把落点迁进 main.sqlite。
 * 领域类型、调度器、工具与 HTTP 契约都不变，只更换事实的存储位置。
 *
 * 结构约定：
 * - 一行一个任务，id 为主键；position 保存旧 JSON 数组中的原始次序，读取顺序与旧文档
 *   完全一致（新增追加到尾部，删除只影响其后行的 position）。
 * - 排期时刻由库内约束守住：daily 只接受严格 HH:mm（前导零必填），once 只接受带时区的
 *   ISO 时刻且必须是真实存在的日历日期；非法时刻写不进库。
 * - 控制事实拆成 last_control_action/last_control_at 两列并强制成对出现，避免半截控制
 *   记录；control_state 与 last_status 用 CHECK 限定枚举。
 * - origin_session_id 故意不建外键：会话仍是 JSON/JSONL 事实源，本次不动会话存储。
 * - 日期列的“可解析”由库内 julianday 约束与读取时的领域校验共同守住；只有合法形状能落库。
 */

export const JOBS_TABLE = "jobs";

/** daily 时刻：严格 HH:mm，00:00 至 23:59，前导零必须完整。 */
const DAILY_AT_CHECK =
  "(typeof(at) = 'text' AND (at GLOB '[0-1][0-9]:[0-5][0-9]' OR at GLOB '2[0-3]:[0-5][0-9]'))";

/**
 * once 时刻：ISO 日期时间 + 显式时区，并要求是真实存在的日历日期。
 * SQLite 的日期函数会把 2 月 30 日进位成 3 月 2 日，因此这里额外用“格式化后必须等于原串”
 * 拒绝不存在的日期；小时与分钟也必须落在合法区间。
 */
const ONCE_AT_CHECK = `(
  typeof(at) = 'text'
  AND at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][Tt][0-9][0-9]:[0-9][0-9]*'
  AND CAST(substr(at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
  AND CAST(substr(at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
  AND strftime('%Y-%m-%d', substr(at, 1, 10)) IS substr(at, 1, 10)
  AND strftime('%Y-%m-%dT%H:%M:%f', at) IS NOT NULL
  AND (
    at GLOB '*Z' OR at GLOB '*z'
    OR at GLOB '*+[0-9][0-9]:[0-9][0-9]' OR at GLOB '*+[0-9][0-9][0-9][0-9]'
    OR at GLOB '*-[0-9][0-9]:[0-9][0-9]' OR at GLOB '*-[0-9][0-9][0-9][0-9]'
  )
)`;

const JOBS_TABLE_DDL = `CREATE TABLE ${JOBS_TABLE} (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  daily INTEGER NOT NULL CHECK (daily IN (0, 1)),
  at TEXT NOT NULL CHECK (CASE daily WHEN 1 THEN ${DAILY_AT_CHECK} ELSE ${ONCE_AT_CHECK} END),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT CHECK (updated_at IS NULL OR julianday(updated_at) IS NOT NULL),
  next_run_at TEXT NOT NULL CHECK (julianday(next_run_at) IS NOT NULL),
  last_run_at TEXT CHECK (last_run_at IS NULL OR julianday(last_run_at) IS NOT NULL),
  last_status TEXT CHECK (last_status IN ('completed', 'failed')),
  last_result TEXT,
  control_state TEXT CHECK (control_state IN ('paused', 'cancelled', 'retry_pending')),
  last_control_action TEXT CHECK (last_control_action IN ('pause', 'resume', 'cancel', 'retry')),
  last_control_at TEXT CHECK (last_control_at IS NULL OR julianday(last_control_at) IS NOT NULL),
  origin_session_id TEXT,
  CHECK ((last_control_action IS NULL) = (last_control_at IS NULL))
)`;

/** 按来源会话级联删除是任务的既有删除路径，索引只服务查询，不改变语义。 */
const JOBS_ORIGIN_INDEX_DDL =
  `CREATE INDEX IF NOT EXISTS ${JOBS_TABLE}_origin_session_id ON ${JOBS_TABLE} (origin_session_id)`;

/** 迁移账本条目：模块 id、当前结构版本、拥有的表与建表语句。 */
export const jobsModule: SqliteModule = {
  id: "jobs",
  version: 1,
  tables: [JOBS_TABLE],
  ddl: [JOBS_TABLE_DDL, JOBS_ORIGIN_INDEX_DDL],
};

const LAST_STATUS = ["completed", "failed"];
const CONTROL_STATES = ["paused", "cancelled", "retry_pending"];
const CONTROL_ACTIONS = ["pause", "resume", "cancel", "retry"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isDate = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const optionalDate = (value: unknown) => value === undefined || isDate(value);

/**
 * 领域形状校验：与旧 readJobsDocument 同一套规则迁移而来。
 * 任一坏记录拒绝整个读取结果，不静默过滤、不补默认值；坏时刻直接拒绝而不是进位。
 */
export const parseJobItem = (value: unknown): Job => {
  if (!isObject(value) ||
    typeof value.id !== "string" || value.id.length === 0 ||
    typeof value.prompt !== "string" ||
    typeof value.daily !== "boolean" || typeof value.at !== "string" ||
    // 每日时刻与领域共用同一严格规则（00:00 至 23:59，前导零必填），不维护第二套正则。
    !(value.daily ? isStrictDailyTime(value.at) : isIsoWithTimezone(value.at)) ||
    typeof value.enabled !== "boolean" ||
    !isDate(value.createdAt) || !optionalDate(value.updatedAt) || !isDate(value.nextRunAt) ||
    !optionalDate(value.lastRunAt) || !optionalString(value.lastResult) ||
    (value.lastStatus !== undefined &&
      (typeof value.lastStatus !== "string" || !LAST_STATUS.includes(value.lastStatus))) ||
    (value.controlState !== undefined &&
      (typeof value.controlState !== "string" || !CONTROL_STATES.includes(value.controlState))) ||
    (value.lastControl !== undefined &&
      (!isObject(value.lastControl) ||
        typeof value.lastControl.action !== "string" || !CONTROL_ACTIONS.includes(value.lastControl.action) ||
        !isDate(value.lastControl.at))) ||
    (value.originSessionId !== undefined && typeof value.originSessionId !== "string")) {
    throw new InvalidDocumentError("jobs");
  }
  return value as unknown as Job;
};

/** 校验整组任务并返回同一批对象；重复 id 视为损坏，不靠数据库主键异常表达。 */
export const parseJobs = (value: unknown): Job[] => {
  if (!Array.isArray(value)) throw new InvalidDocumentError("jobs");
  const jobs = value.map((item) => parseJobItem(item));
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length) throw new InvalidDocumentError("jobs");
  return jobs;
};

type JobRow = {
  id: string;
  position: number;
  prompt: string;
  daily: number;
  at: string;
  enabled: number;
  created_at: string;
  updated_at: string | null;
  next_run_at: string;
  last_run_at: string | null;
  last_status: string | null;
  last_result: string | null;
  control_state: string | null;
  last_control_action: string | null;
  last_control_at: string | null;
  origin_session_id: string | null;
};

/** 除主键外的全部业务列；写入与差异比较都只使用这张显式清单。 */
const JOB_COLUMNS = [
  "position", "prompt", "daily", "at", "enabled",
  "created_at", "updated_at", "next_run_at", "last_run_at",
  "last_status", "last_result", "control_state",
  "last_control_action", "last_control_at", "origin_session_id",
] as const;

type JobColumn = (typeof JOB_COLUMNS)[number];
type JobRowValues = Record<JobColumn, string | number | null>;

/** 行内文本列：非文本一律是损坏，不能被当成默认字符串。 */
const rowText = (value: unknown): string => {
  if (typeof value !== "string") throw new InvalidDocumentError("jobs");
  return value;
};

/** 行内布尔列：只接受 0/1，其他取值说明库被写坏，不做真假兜底。 */
const rowFlag = (value: unknown): boolean => {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new InvalidDocumentError("jobs");
};

const rowToJob = (row: JobRow): Job => ({
  id: rowText(row.id),
  prompt: rowText(row.prompt),
  daily: rowFlag(row.daily),
  at: rowText(row.at),
  enabled: rowFlag(row.enabled),
  createdAt: rowText(row.created_at),
  nextRunAt: rowText(row.next_run_at),
  ...(row.updated_at !== null ? { updatedAt: rowText(row.updated_at) } : {}),
  ...(row.last_run_at !== null ? { lastRunAt: rowText(row.last_run_at) } : {}),
  ...(row.last_status !== null ? { lastStatus: row.last_status as Job["lastStatus"] } : {}),
  ...(row.last_result !== null ? { lastResult: rowText(row.last_result) } : {}),
  ...(row.control_state !== null ? { controlState: row.control_state as Job["controlState"] } : {}),
  ...(row.last_control_action !== null && row.last_control_at !== null
    ? { lastControl: { action: row.last_control_action as JobControlAction, at: rowText(row.last_control_at) } }
    : {}),
  ...(row.origin_session_id !== null ? { originSessionId: rowText(row.origin_session_id) } : {}),
});

const jobToRow = (job: Job, position: number): JobRowValues => ({
  position,
  prompt: job.prompt,
  daily: job.daily ? 1 : 0,
  at: job.at,
  enabled: job.enabled ? 1 : 0,
  created_at: job.createdAt,
  updated_at: job.updatedAt ?? null,
  next_run_at: job.nextRunAt,
  last_run_at: job.lastRunAt ?? null,
  last_status: job.lastStatus ?? null,
  last_result: job.lastResult ?? null,
  control_state: job.controlState ?? null,
  last_control_action: job.lastControl?.action ?? null,
  last_control_at: job.lastControl?.at ?? null,
  origin_session_id: job.originSessionId ?? null,
});

/**
 * 读取前的结构体检：模块未登记时明确失败，不接管别的表；
 * 日期列用与库内 CHECK 相同的解析器复核，避免绕过 CHECK 写入的脏时间被当成事实。
 */
const assertJobsTable = (managed: ManagedSqliteDatabase): void => {
  const exists = managed.database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(JOBS_TABLE);
  if (!exists) throw new Error(`Invalid main database: module jobs is missing table ${JOBS_TABLE}`);
};

const INVALID_DATE_ROWS = `SELECT id FROM ${JOBS_TABLE}
WHERE (created_at IS NOT NULL AND julianday(created_at) IS NULL)
   OR (updated_at IS NOT NULL AND julianday(updated_at) IS NULL)
   OR (next_run_at IS NOT NULL AND julianday(next_run_at) IS NULL)
   OR (last_run_at IS NOT NULL AND julianday(last_run_at) IS NULL)
   OR (last_control_at IS NOT NULL AND julianday(last_control_at) IS NULL)`;

/** 读取全部任务：按 position 稳定排序，坏记录整体拒绝。 */
export const readJobs = (managed: ManagedSqliteDatabase): Job[] => {
  assertJobsTable(managed);
  const database = managed.database;
  const invalid = database.prepare(INVALID_DATE_ROWS).all();
  if (invalid.length > 0) throw new InvalidDocumentError("jobs");
  const rows = database.prepare(
    `SELECT id, ${JOB_COLUMNS.join(", ")} FROM ${JOBS_TABLE} ORDER BY position, id`,
  ).all() as unknown as JobRow[];
  return rows.map((row) => {
    // 控制动作与控制时刻必须成对出现，半截记录是损坏而不是“未控制”。
    if ((row.last_control_action === null) !== (row.last_control_at === null)) {
      throw new InvalidDocumentError("jobs");
    }
    return parseJobItem(rowToJob(row));
  });
};

/**
 * 行级 diff 提交：previous 是本次事务前读回的聚合，next 是业务回调产生并已校验的新聚合。
 * 只增删改发生变化的行与变化的列；未变化的行连 position 都不重写，
 * Agent 追加的列也不会被业务写入整表抹掉。
 */
export const applyJobs = (
  managed: ManagedSqliteDatabase,
  previous: Job[],
  next: Job[],
): void => {
  const database = managed.database;
  const previousById = new Map(previous.map((job, index) => [job.id, { job, index }]));
  const nextIds = new Set(next.map((job) => job.id));

  for (const job of previous) {
    if (nextIds.has(job.id)) continue;
    database.prepare(`DELETE FROM ${JOBS_TABLE} WHERE id = ?`).run(job.id);
  }

  next.forEach((job, index) => {
    const values = jobToRow(job, index);
    const old = previousById.get(job.id);
    if (!old) {
      const placeholders = JOB_COLUMNS.map(() => "?").join(", ");
      database.prepare(
        `INSERT INTO ${JOBS_TABLE} (id, ${JOB_COLUMNS.join(", ")}) VALUES (?, ${placeholders})`,
      ).run(job.id, ...JOB_COLUMNS.map((column) => values[column]));
      return;
    }
    const oldValues = jobToRow(old.job, old.index);
    const changed = JOB_COLUMNS.filter((column) => oldValues[column] !== values[column]);
    if (changed.length === 0) return;
    database.prepare(
      `UPDATE ${JOBS_TABLE} SET ${changed.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
    ).run(...changed.map((column) => values[column]), job.id);
  });
};
