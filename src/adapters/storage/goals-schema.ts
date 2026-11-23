import type { DatabaseSync } from "node:sqlite";
import { InvalidDocumentError } from "./document-schemas.js";
import {
  ensureSqliteModules,
  SQLITE_MODULE_LEDGER_TABLE,
  type SqliteModule,
} from "./sqlite-modules.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import type { Goal, GoalStatus, Milestone } from "../../features/goals/types.js";

/**
 * goals 模块在 main.sqlite 的表结构与行映射。
 *
 * - 目标与里程碑都是显式列：读取只声明显式列，写入只写已知列，Agent 加列不会被
 *   业务全量重写抹掉；行级 diff 只触碰真正变化的行。
 * - 顺序用 position 保真：目标 position 是它在文档数组中的序号，里程碑 position
 *   是它在所属目标内的序号，读取与回写保持同一顺序语义。
 * - 里程碑通过外键挂在目标上，删除目标由数据库级联清理其里程碑，不留孤儿行。
 * - 状态与完成标记用 CHECK 约束在库层兜底；读取与写入两端再做一次同样的领域校验，
 *   坏数据明确报错，不静默过滤也不补默认值。
 *
 * 与旧 goals.json 的差异只在存储形态：目标标题、描述、分类、状态、时间与里程碑
 * 全部保留，旧 JSON 文档不再被读取或双写。
 */

export const goalsModule: SqliteModule = {
  id: "goals",
  version: 1,
  tables: ["goals", "goal_milestones"],
  ddl: [
    `CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'archived')),
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      description TEXT NOT NULL,
      category TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS goal_milestones (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      done INTEGER NOT NULL CHECK (done IN (0, 1)),
      position INTEGER NOT NULL,
      done_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS goal_milestones_goal_id_index ON goal_milestones (goal_id)`,
  ],
};

const tableExists = (database: DatabaseSync, table: string): boolean =>
  Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * 建立或校验 goals 模块结构。
 *
 * - 全新库（账本尚未建立）：按账本规则登记本模块并建表。
 * - 账本里已登记 goals：版本必须一致且表必须齐全，否则明确失败。
 * - 账本里已有别的模块但没有 goals：视为结构未安装，明确失败并提示注册路径，
 *   不擅自建表接管其他模块的库。
 */
export const ensureGoalsModule = (managed: ManagedSqliteDatabase): void => {
  const database = managed.database;
  if (!tableExists(database, SQLITE_MODULE_LEDGER_TABLE)) {
    ensureSqliteModules(managed, [goalsModule]);
    return;
  }
  const registered = database
    .prepare(`SELECT version FROM ${SQLITE_MODULE_LEDGER_TABLE} WHERE module = ?`)
    .get(goalsModule.id) as { version: number } | undefined;
  if (!registered) {
    const others = database
      .prepare(`SELECT module FROM ${SQLITE_MODULE_LEDGER_TABLE} WHERE module <> ?`)
      .all(goalsModule.id) as Array<{ module: string }>;
    if (others.length > 0) {
      throw new Error(
        `Invalid main database: goals module is not installed; register ${goalsModule.id}Module before opening the goal repository`,
      );
    }
    ensureSqliteModules(managed, [goalsModule]);
    return;
  }
  if (registered.version !== goalsModule.version) {
    throw new Error(
      `Invalid main database: module ${goalsModule.id} has version ${registered.version}, expected ${goalsModule.version}`,
    );
  }
  for (const table of goalsModule.tables) {
    if (!tableExists(database, table)) {
      throw new Error(`Invalid main database: module ${goalsModule.id} is missing table ${table}`);
    }
  }
};

/**
 * 目标文档的严格校验：先复用旧 JSON 文档的基础形状规则，再补上库层新增的约束
 * （标题与里程碑标题非空、描述/分类/时间为字符串、目标与里程碑 id 不重复）。
 * 任一条不满足都整体拒绝，不静默过滤坏条目，也不补默认值。
 */
export const parseGoals = (value: unknown): Goal[] => {
  if (!Array.isArray(value)) throw new InvalidDocumentError("goals");
  const statuses = ["active", "paused", "completed", "archived"];
  const base = value.filter((item): item is Goal => {
    const goal = item as unknown as Record<string, unknown>;
    return goal !== null && typeof goal === "object" && !Array.isArray(goal) &&
      typeof goal.id === "string" &&
      typeof goal.title === "string" &&
      typeof goal.status === "string" && statuses.includes(goal.status) &&
      Array.isArray(goal.milestones) &&
      (goal.milestones as unknown[]).every((milestone) => {
        const row = milestone as Record<string, unknown>;
        return row !== null && typeof row === "object" && !Array.isArray(row) &&
          typeof row.id === "string" && typeof row.title === "string" && typeof row.done === "boolean";
      });
  });
  if (base.length !== value.length) throw new InvalidDocumentError("goals");
  const goalIds = new Set<string>();
  const milestoneIds = new Set<string>();
  return base.map((item) => {
    const goal = item as unknown as Record<string, unknown>;
    if (
      !isNonEmptyString(goal.id) ||
      !isNonEmptyString(goal.title) ||
      typeof goal.description !== "string" ||
      typeof goal.category !== "string" ||
      typeof goal.createdAt !== "string" ||
      goal.createdAt.length === 0 ||
      typeof goal.updatedAt !== "string" ||
      goal.updatedAt.length === 0
    ) {
      throw new InvalidDocumentError("goals");
    }
    if (goalIds.has(goal.id)) throw new InvalidDocumentError("goals");
    goalIds.add(goal.id);
    const milestones: Milestone[] = [];
    for (const raw of goal.milestones as unknown[]) {
      const milestone = raw as Record<string, unknown>;
      if (
        !isNonEmptyString(milestone.id) ||
        !isNonEmptyString(milestone.title) ||
        typeof milestone.done !== "boolean" ||
        (milestone.doneAt !== undefined && (typeof milestone.doneAt !== "string" || milestone.doneAt.length === 0))
      ) {
        throw new InvalidDocumentError("goals");
      }
      if (milestoneIds.has(milestone.id)) throw new InvalidDocumentError("goals");
      milestoneIds.add(milestone.id);
      milestones.push({
        id: milestone.id,
        title: milestone.title,
        done: milestone.done,
        ...(milestone.doneAt !== undefined ? { doneAt: milestone.doneAt } : {}),
      });
    }
    return {
      id: goal.id,
      title: goal.title,
      description: goal.description,
      category: goal.category,
      status: goal.status as GoalStatus,
      milestones,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    };
  });
};

type GoalRow = {
  id: string;
  title: string;
  status: GoalStatus;
  position: number;
  created_at: string;
  updated_at: string | null;
  description: string;
  category: string;
};

type MilestoneRow = {
  id: string;
  goal_id: string;
  title: string;
  done: number;
  position: number;
  done_at: string | null;
};

/**
 * 从显式列读回目标聚合：目标按 position 保序，里程碑按所属目标内的 position 保序。
 * 读到的坏数据（非法完成标记、孤儿里程碑、空时间）一律按旧文档同一规则报错。
 */
export const readGoals = (managed: ManagedSqliteDatabase): Goal[] => {
  const database = managed.database;
  const goalRows = database
    .prepare("SELECT id, title, status, position, created_at, updated_at, description, category FROM goals ORDER BY position, id")
    .all() as GoalRow[];
  const milestoneRows = database
    .prepare("SELECT id, goal_id, title, done, position, done_at FROM goal_milestones ORDER BY goal_id, position")
    .all() as MilestoneRow[];
  const goalIds = new Set(goalRows.map((row) => row.id));
  const milestonesByGoal = new Map<string, Milestone[]>();
  for (const row of milestoneRows) {
    if (row.done !== 0 && row.done !== 1) throw new InvalidDocumentError("goals");
    // 孤儿里程碑说明外键已被绕过，属于结构损坏，不静默丢弃。
    if (!goalIds.has(row.goal_id)) throw new InvalidDocumentError("goals");
    const list = milestonesByGoal.get(row.goal_id) ?? [];
    list.push({
      id: row.id,
      title: row.title,
      done: row.done === 1,
      ...(row.done_at !== null ? { doneAt: row.done_at } : {}),
    });
    milestonesByGoal.set(row.goal_id, list);
  }
  return parseGoals(
    goalRows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category,
      status: row.status,
      milestones: milestonesByGoal.get(row.id) ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? "",
    })),
  );
};

/**
 * 行级 diff 提交：previous 是本次事务前读回的聚合，next 是业务回调产生并通过
 * 严格校验的新聚合。只增删改发生变化的行，不整表重写；删除目标时由外键级联清理
 * 它的里程碑，写入顺序先目标后里程碑，满足外键约束。
 */
export const applyGoals = (managed: ManagedSqliteDatabase, previous: Goal[], next: Goal[]): void => {
  const database = managed.database;
  const previousById = new Map(previous.map((goal) => [goal.id, goal]));
  const nextIds = new Set(next.map((goal) => goal.id));
  const nextMilestoneIds = new Set(next.flatMap((goal) => goal.milestones.map((milestone) => milestone.id)));

  // 顺序存在库里，不在聚合对象里；diff 基线必须取库中的真实 position。
  const storedGoalPosition = new Map(
    (database.prepare("SELECT id, position FROM goals").all() as Array<{ id: string; position: number }>)
      .map((row) => [row.id, row.position]),
  );
  const storedMilestone = new Map(
    (database.prepare("SELECT id, goal_id, position FROM goal_milestones").all() as Array<{ id: string; goal_id: string; position: number }>)
      .map((row) => [row.id, row]),
  );

  // 删除阶段：目标行删除后由外键级联清理它的里程碑；只在整份文档里消失的里程碑
  // 才单独删除，转移到别的目标的里程碑由写入阶段改挂。
  for (const goal of previous) {
    if (!nextIds.has(goal.id)) database.prepare("DELETE FROM goals WHERE id = ?").run(goal.id);
  }
  for (const goal of previous) {
    for (const milestone of goal.milestones) {
      if (!nextMilestoneIds.has(milestone.id)) {
        database.prepare("DELETE FROM goal_milestones WHERE id = ?").run(milestone.id);
      }
    }
  }

  // 写入阶段：先目标后里程碑。
  next.forEach((goal, index) => {
    const old = previousById.get(goal.id);
    const goalChanged =
      !old ||
      old.title !== goal.title ||
      old.description !== goal.description ||
      old.category !== goal.category ||
      old.status !== goal.status ||
      storedGoalPosition.get(goal.id) !== index ||
      old.createdAt !== goal.createdAt ||
      old.updatedAt !== goal.updatedAt;
    if (goalChanged) {
      database
        .prepare(
          "INSERT INTO goals (id, title, status, position, created_at, updated_at, description, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, position = excluded.position, " +
          "created_at = excluded.created_at, updated_at = excluded.updated_at, description = excluded.description, category = excluded.category",
        )
        .run(goal.id, goal.title, goal.status, index, goal.createdAt, goal.updatedAt, goal.description, goal.category);
    }

    const previousMilestones = old?.milestones ?? [];
    goal.milestones.forEach((milestone, milestoneIndex) => {
      const oldMilestone = previousMilestones.find((candidate) => candidate.id === milestone.id);
      const stored = storedMilestone.get(milestone.id);
      const milestoneChanged =
        !oldMilestone ||
        oldMilestone.title !== milestone.title ||
        oldMilestone.done !== milestone.done ||
        (oldMilestone.doneAt ?? null) !== (milestone.doneAt ?? null) ||
        stored?.goal_id !== goal.id ||
        stored?.position !== milestoneIndex;
      if (!milestoneChanged) return;
      database
        .prepare(
          "INSERT INTO goal_milestones (id, goal_id, title, done, position, done_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET goal_id = excluded.goal_id, title = excluded.title, done = excluded.done, " +
          "position = excluded.position, done_at = excluded.done_at",
        )
        .run(milestone.id, goal.id, milestone.title, milestone.done ? 1 : 0, milestoneIndex, milestone.doneAt ?? null);
    });
  });
};
