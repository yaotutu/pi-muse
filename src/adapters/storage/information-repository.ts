import { z } from "zod";
import {
  defaultInformationState,
  type InformationRepository,
  type InformationState,
} from "../../features/information/types.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import {
  applySmsState,
  ensureSmsModule,
  readNextRealtimeDue,
  readSmsState,
} from "./sms-schema.js";

const isoTime = z.string().datetime();

const itemSchema = z.strictObject({
  id: z.string().min(1).max(128),
  queue: z.enum(["realtime", "archive"]),
  source: z.string().min(1).max(128),
  externalId: z.string().min(1).max(256),
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(20_000),
  receivedAt: isoTime,
  acceptedAt: isoTime,
  status: z.enum(["pending", "processing", "processed", "failed"]),
  runId: z.string().min(1).max(128).optional(),
});

const decisionSchema = z.strictObject({
  itemId: z.string().min(1).max(128),
  decision: z.enum(["silent", "notify"]),
  reason: z.string().min(1).max(1000),
});

const publicationSchema = z.strictObject({
  notificationId: z.string().min(1).max(200),
  text: z.string().min(1).max(4000),
  itemIds: z.array(z.string().min(1).max(128)),
  status: z.enum(["pending", "published", "failed"]),
  receipt: z.strictObject({
    notificationId: z.string().min(1).max(200),
    piSessionId: z.string().min(1).max(128),
    messageId: z.string().min(1).max(200),
  }).optional(),
  error: z.string().min(1).max(300).optional(),
});

const runSchema = z.strictObject({
  id: z.string().min(1).max(128),
  kind: z.enum(["realtime", "archive"]),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  createdAt: isoTime,
  startedAt: isoTime,
  finishedAt: isoTime.optional(),
  itemIds: z.array(z.string().min(1).max(128)).min(1),
  model: z.strictObject({
    status: z.enum(["succeeded", "failed"]),
    error: z.string().min(1).max(300).optional(),
  }).optional(),
  decisions: z.array(decisionSchema).optional(),
  publications: z.array(publicationSchema),
});

export const informationStateSchema = z.strictObject({
  schemaVersion: z.literal(2),
  settings: z.strictObject({
    enabled: z.boolean(),
    batchWindowSeconds: z.number().int().min(0).max(3600),
  }),
  preferences: z.strictObject({
    learnedNotes: z.string().max(20_000),
  }),
  items: z.array(itemSchema),
  runs: z.array(runSchema),
});

export const parseInformationState = (value: unknown): InformationState => {
  if (value === undefined) return defaultInformationState();
  const parsed = informationStateSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid information state: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  }
  const state = parsed.data;
  const unique = (values: readonly string[]) => new Set(values).size === values.length;
  const itemIds = new Set(state.items.map((item) => item.id));
  if (
    !unique(state.items.map((item) => item.id)) ||
    !unique(state.items.map((item) => JSON.stringify([item.source, item.externalId]))) ||
    !unique(state.runs.map((run) => run.id)) ||
    state.runs.some(
      (run) =>
        !unique(run.itemIds) ||
        run.itemIds.some((id) => !itemIds.has(id)) ||
        !unique((run.decisions ?? []).map((decision) => decision.itemId)) ||
        run.decisions?.some((decision) => !run.itemIds.includes(decision.itemId)),
    )
  ) {
    throw new Error("Invalid information state: duplicate identity or broken relation");
  }
  return state;
};

/**
 * 短信/信息仓储（Clean Break v2）：持久化到 main.sqlite sms_* 表；
 * nextRealtimeDue 通过单次索引 SQL 查询完成，避免空闲周期全表反序列化。
 */
export const createInformationRepository = (managed: ManagedSqliteDatabase): InformationRepository => {
  let ensured = false;
  const ensureOnce = () => {
    if (ensured) return;
    ensureSmsModule(managed);
    ensured = true;
  };
  const readValidated = (): InformationState => {
    ensureOnce();
    return parseInformationState(readSmsState(managed));
  };
  const write = (current: InformationState, next: InformationState) => {
    const validated = parseInformationState(next);
    managed.transaction(() => applySmsState(managed, current, validated));
    return validated;
  };

  return {
    read: () => managed.serialize(() => readValidated()),
    update: (change) => managed.serialize(async () => {
      const current = readValidated();
      const changed = await change(structuredClone(current));
      if (changed.state) write(current, changed.state);
      return changed.result;
    }),
    validateAll: () => managed.serialize(() => {
      readValidated();
    }),
    nextRealtimeDue: () => managed.serialize(() => {
      ensureOnce();
      return readNextRealtimeDue(managed);
    }),
    reconcileOnStart: () => managed.serialize(() => {
      const current = readValidated();
      const hasRunning = current.runs.some((run) => run.status === "running");
      const hasProcessing = current.items.some((item) => item.status === "processing");
      const hasPendingPubs = current.runs.some((run) =>
        run.publications.some((pub) => pub.status === "pending"));
      if (!hasRunning && !hasProcessing && !hasPendingPubs) return;

      const now = new Date().toISOString();
      const failedMidModelRunIds = new Set<string>();
      const activeRunIds = new Set<string>();

      const runs = current.runs.map((run) => {
        if (run.status === "completed") {
          if (!run.publications.some((pub) => pub.status === "pending")) return run;
          return {
            ...run,
            publications: run.publications.map((pub) =>
              pub.status === "pending"
                ? { ...pub, status: "failed" as const, error: "Interrupted by service restart" }
                : pub),
          };
        }
        if (run.status !== "running") return run;
        if (run.model?.status === "succeeded") {
          // 模型判定已落库，仅通知投递未完成；将 pending 通知收敛为 failed，保留 processed 条目。
          return {
            ...run,
            status: "completed" as const,
            finishedAt: now,
            publications: run.publications.map((pub) =>
              pub.status === "pending"
                ? { ...pub, status: "failed" as const, error: "Interrupted by service restart" }
                : pub),
          };
        }
        failedMidModelRunIds.add(run.id);
        return {
          ...run,
          status: "failed" as const,
          finishedAt: now,
          model: { status: "failed" as const, error: "Interrupted by service restart" },
        };
      });

      for (const run of runs) {
        if (run.status === "running") activeRunIds.add(run.id);
      }

      const items = current.items.map((item) => {
        if (item.status !== "processing") return item;
        if (item.runId && !failedMidModelRunIds.has(item.runId) && activeRunIds.has(item.runId)) {
          return item;
        }
        const { runId: _drop, ...rest } = item;
        return { ...rest, status: "pending" as const };
      });

      write(current, { ...current, items, runs });
    }),
  };
};
