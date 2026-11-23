import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HabitError } from "../../features/habits/errors.js";
import {
  MAX_HABITS_PER_DOMAIN,
  type HabitDomainMeta,
  type HabitItem,
  type HabitOperation,
  type HabitRepository,
  type HabitRunStatus,
  type HabitSignalPayload,
  type HabitSignalRecord,
  type HabitSource,
} from "../../features/habits/types.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import { ensureHabitsModule } from "./habits-schema.js";

type HabitRow = {
  id: string;
  domain: string;
  position: number;
  text: string;
  source: HabitSource;
  created_at: string;
  updated_at: string;
};

type DomainRow = {
  domain: string;
  cursor_seq: number;
  last_run_at: string | null;
  last_run_status: HabitRunStatus | null;
  last_run_processed: number;
  last_run_error: string | null;
};

type SignalRow = {
  seq: number;
  domain: string;
  target_id: string;
  payload_json: string;
  created_at: string;
};

const newHabitId = () => `hab_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

const rowToHabit = (row: HabitRow): HabitItem => ({
  id: row.id,
  domain: row.domain,
  text: row.text,
  source: row.source,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const readDomainHabitsSync = (database: DatabaseSync, domain: string): HabitItem[] =>
  (database
    .prepare(
      "SELECT id, domain, position, text, source, created_at, updated_at FROM habit_items WHERE domain = ? ORDER BY position",
    )
    .all(domain) as unknown as HabitRow[]).map(rowToHabit);

const readDomainMetaSync = (database: DatabaseSync, domain: string): HabitDomainMeta => {
  const row = database
    .prepare(
      "SELECT domain, cursor_seq, last_run_at, last_run_status, last_run_processed, last_run_error FROM habit_domains WHERE domain = ?",
    )
    .get(domain) as DomainRow | undefined;
  if (!row) {
    return {
      domain,
      cursorSeq: 0,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunProcessed: 0,
      lastRunError: null,
    };
  }
  return {
    domain: row.domain,
    cursorSeq: row.cursor_seq,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastRunProcessed: row.last_run_processed,
    lastRunError: row.last_run_error,
  };
};

const applyOperationsInMemory = (
  current: readonly HabitItem[],
  operations: readonly HabitOperation[],
  options: {
    domain: string;
    source: HabitSource;
    now: string;
    expectedUpdatedAt?: ReadonlyMap<string, string>;
  },
): HabitItem[] => {
  const items = [...current];
  const hasDuplicateText = (text: string, excludeId?: string) => {
    const target = text.trim().toLowerCase();
    return items.some((item) => item.id !== excludeId && item.text.trim().toLowerCase() === target);
  };
  const isStaleEdit = (id: string): boolean => {
    if (!options.expectedUpdatedAt || !options.expectedUpdatedAt.has(id)) return false;
    const currentItem = items.find((item) => item.id === id);
    return !currentItem || currentItem.updatedAt !== options.expectedUpdatedAt.get(id);
  };

  for (const op of operations) {
    if (op.op === "delete") {
      if (isStaleEdit(op.id)) continue;
      const idx = items.findIndex((item) => item.id === op.id);
      if (idx !== -1) items.splice(idx, 1);
      continue;
    }
    if (op.op === "edit") {
      if (isStaleEdit(op.id)) continue;
      const idx = items.findIndex((item) => item.id === op.id);
      if (idx === -1) continue;
      if (hasDuplicateText(op.text, op.id)) continue;
      items[idx] = {
        ...items[idx]!,
        text: op.text,
        source: options.source,
        updatedAt: options.now,
      };
      continue;
    }
    if (op.op === "add") {
      if (items.length >= MAX_HABITS_PER_DOMAIN) continue;
      if (hasDuplicateText(op.text)) continue;
      items.push({
        id: newHabitId(),
        domain: options.domain,
        text: op.text,
        source: options.source,
        createdAt: options.now,
        updatedAt: options.now,
      });
    }
  }
  return items;
};

/** 清空并按连续 position 重写单个域的习惯行（事务内执行，避免 UNIQUE(domain, position) 瞬态碰撞）。 */
const rewriteDomainHabitsSync = (
  database: DatabaseSync,
  domain: string,
  items: readonly HabitItem[],
): void => {
  database.prepare("DELETE FROM habit_items WHERE domain = ?").run(domain);
  const insert = database.prepare(
    "INSERT INTO habit_items (id, domain, position, text, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  items.forEach((item, index) => {
    insert.run(item.id, domain, index, item.text, item.source, item.createdAt, item.updatedAt);
  });
};

const parseSignalPayload = (raw: string): HabitSignalPayload => {
  try {
    return JSON.parse(raw) as HabitSignalPayload;
  } catch {
    throw new Error("Invalid main database: corrupted habit signal payload");
  }
};

/** 通用习惯归纳仓储：持久化到 main.sqlite 的 habit_domains / habit_items / habit_signals。 */
export const createHabitsRepository = (managed: ManagedSqliteDatabase): HabitRepository => {
  let ensured = false;
  const ensureOnce = () => {
    if (ensured) return;
    ensureHabitsModule(managed);
    ensured = true;
  };

  return {
    validateAll: () => managed.serialize(() => {
      ensureOnce();
      const rows = managed.database
        .prepare("SELECT payload_json FROM habit_signals LIMIT 1000")
        .all() as unknown as Array<{ payload_json: string }>;
      for (const row of rows) {
        parseSignalPayload(row.payload_json);
      }
    }),

    listHabits: (domain) => managed.serialize(() => {
      ensureOnce();
      return readDomainHabitsSync(managed.database, domain);
    }),

    getDomainMeta: (domain) => managed.serialize(() => {
      ensureOnce();
      return readDomainMetaSync(managed.database, domain);
    }),

    addHabit: (domain, text, source) => managed.serialize(() => {
      ensureOnce();
      const now = new Date().toISOString();
      return managed.transaction(() => {
        const current = readDomainHabitsSync(managed.database, domain);
        if (current.length >= MAX_HABITS_PER_DOMAIN) {
          throw new HabitError(
            "LIMIT_EXCEEDED",
            `At most ${MAX_HABITS_PER_DOMAIN} habits are allowed for domain ${domain}`,
          );
        }
        const created: HabitItem = {
          id: newHabitId(),
          domain,
          text,
          source,
          createdAt: now,
          updatedAt: now,
        };
        managed.database
          .prepare(
            "INSERT INTO habit_items (id, domain, position, text, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(created.id, domain, current.length, created.text, created.source, created.createdAt, created.updatedAt);
        return created;
      });
    }),

    updateHabit: (domain, habitId, text) => managed.serialize(() => {
      ensureOnce();
      const now = new Date().toISOString();
      return managed.transaction(() => {
        const existing = managed.database
          .prepare(
            "SELECT id, domain, position, text, source, created_at, updated_at FROM habit_items WHERE domain = ? AND id = ?",
          )
          .get(domain, habitId) as HabitRow | undefined;
        if (!existing) {
          throw new HabitError("NOT_FOUND", `Unknown habit ${habitId} in domain ${domain}`);
        }
        managed.database
          .prepare("UPDATE habit_items SET text = ?, updated_at = ? WHERE domain = ? AND id = ?")
          .run(text, now, domain, habitId);
        return {
          id: existing.id,
          domain: existing.domain,
          text,
          source: existing.source,
          createdAt: existing.created_at,
          updatedAt: now,
        };
      });
    }),

    deleteHabit: (domain, habitId) => managed.serialize(() => {
      ensureOnce();
      return managed.transaction(() => {
        const current = readDomainHabitsSync(managed.database, domain);
        if (!current.some((item) => item.id === habitId)) {
          throw new HabitError("NOT_FOUND", `Unknown habit ${habitId} in domain ${domain}`);
        }
        const next = current.filter((item) => item.id !== habitId);
        rewriteDomainHabitsSync(managed.database, domain, next);
        return { deleted: true as const, id: habitId };
      });
    }),

    appendSignal: (domain, targetId, payload) => managed.serialize(() => {
      ensureOnce();
      const createdAt = new Date().toISOString();
      const payloadJson = JSON.stringify(payload);
      return managed.transaction(() => {
        const result = managed.database
          .prepare(
            "INSERT INTO habit_signals (domain, target_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(domain, targetId, payloadJson, createdAt);
        return {
          seq: Number(result.lastInsertRowid),
          domain,
          targetId,
          payload,
          createdAt,
        };
      });
    }),

    listUnconsolidatedSignals: (domain) => managed.serialize(() => {
      ensureOnce();
      const meta = readDomainMetaSync(managed.database, domain);
      const rows = managed.database
        .prepare(
          "SELECT seq, domain, target_id, payload_json, created_at FROM habit_signals WHERE domain = ? AND seq > ? ORDER BY seq ASC",
        )
        .all(domain, meta.cursorSeq) as unknown as SignalRow[];
      return rows.map<HabitSignalRecord>((row) => ({
        seq: row.seq,
        domain: row.domain,
        targetId: row.target_id,
        payload: parseSignalPayload(row.payload_json),
        createdAt: row.created_at,
      }));
    }),

    applyOperations: (input) => managed.serialize(() => {
      ensureOnce();
      const now = new Date().toISOString();
      return managed.transaction(() => {
        const current = readDomainHabitsSync(managed.database, input.domain);
        const next = applyOperationsInMemory(current, input.operations, {
          domain: input.domain,
          source: input.source,
          now,
          expectedUpdatedAt: input.expectedUpdatedAt,
        });
        rewriteDomainHabitsSync(managed.database, input.domain, next);
        return next;
      });
    }),

    commitConsolidationBatch: (input) => managed.serialize(() => {
      ensureOnce();
      return managed.transaction(() => {
        const current = readDomainHabitsSync(managed.database, input.domain);
        const next = input.operations.length
          ? applyOperationsInMemory(current, input.operations, {
              domain: input.domain,
              source: input.source,
              now: input.at,
              expectedUpdatedAt: input.expectedUpdatedAt,
            })
          : current;
        if (input.operations.length) {
          rewriteDomainHabitsSync(managed.database, input.domain, next);
        }
        managed.database
          .prepare(
            `INSERT INTO habit_domains (domain, cursor_seq, last_run_at, last_run_status, last_run_processed, last_run_error)
             VALUES (?, ?, ?, ?, ?, NULL)
             ON CONFLICT(domain) DO UPDATE SET
               cursor_seq = MAX(habit_domains.cursor_seq, excluded.cursor_seq),
               last_run_at = excluded.last_run_at,
               last_run_status = excluded.last_run_status,
               last_run_processed = excluded.last_run_processed,
               last_run_error = NULL`,
          )
          .run(input.domain, input.advanceCursorToSeq, input.at, input.status, input.processedCount);
        if (input.advanceCursorToSeq > 0) {
          managed.database
            .prepare("DELETE FROM habit_signals WHERE domain = ? AND seq <= ?")
            .run(input.domain, input.advanceCursorToSeq);
        }
        return next;
      });
    }),

    recordRunFailure: (input) => managed.serialize(() => {
      ensureOnce();
      managed.transaction(() => {
        managed.database
          .prepare(
            `INSERT INTO habit_domains (domain, cursor_seq, last_run_at, last_run_status, last_run_processed, last_run_error)
             VALUES (?, 0, ?, ?, 0, ?)
             ON CONFLICT(domain) DO UPDATE SET
               last_run_at = excluded.last_run_at,
               last_run_status = excluded.last_run_status,
               last_run_processed = 0,
               last_run_error = excluded.last_run_error`,
          )
          .run(input.domain, input.at, input.status, input.error);
      });
    }),
  };
};
