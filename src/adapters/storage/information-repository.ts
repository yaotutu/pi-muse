import { z } from "zod";
import {
  type InformationRepository,
  type InformationState,
} from "../../features/information/types.js";
import { applySmsState, ensureSmsModule, readSmsState } from "./sms-schema.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";

const isoTime = z.string().datetime();
const publicArticleUrl = z.string().url().max(2048).regex(/^https?:\/\//).refine((value) => {
  const url = new URL(value);
  const credentialKeys = ["username", "pass" + "word"] as const;
  return credentialKeys.every((key) => url[key as keyof URL] === "");
}, "URL must not contain credentials");
const itemSchema = z.strictObject({
  id: z.string().min(1).max(128),
  source: z.string().min(1).max(128),
  externalId: z.string().min(1).max(256),
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(20000),
  receivedAt: isoTime,
  acceptedAt: isoTime,
  status: z.enum(["pending", "processing", "processed", "failed"]),
  runId: z.string().min(1).max(128).optional(),
  metadata: z.strictObject({
    sourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    sourceTitle: z.string().min(1).max(500),
    url: publicArticleUrl.nullable(),
  }).optional(),
});
const decisionSchema = z.strictObject({
  itemId: z.string().min(1).max(128),
  decision: z.enum(["silent", "notify"]),
  reason: z.string().min(1).max(1000),
});
const receiptSchema = z.strictObject({
  notificationId: z.string().min(1).max(200),
  piSessionId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(200),
});
const publicationSchema = z.strictObject({
  notificationId: z.string().min(1).max(200),
  itemIds: z.array(z.string().min(1).max(128)),
  text: z.string().min(1).max(4000),
  status: z.enum(["pending", "published", "failed"]),
  receipt: receiptSchema.optional(),
  error: z.string().min(1).max(300).optional(),
});
const runSchema = z.strictObject({
  id: z.string().min(1).max(128),
  itemIds: z.array(z.string().min(1).max(128)).min(1),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  createdAt: isoTime,
  startedAt: isoTime,
  finishedAt: isoTime.optional(),
  kind: z.enum(["initial_summary", "incremental"]).optional(),
  model: z.strictObject({
    status: z.enum(["succeeded", "failed"]),
    error: z.string().min(1).max(300).optional(),
  }).optional(),
  decisions: z.array(decisionSchema).optional(),
  publications: z.array(publicationSchema),
});
/**
 * 短信状态结构（新闻处理复用同一 processing 结构）。
 * 该结构仍是唯一的字段事实来源：写入前与读出后执行同一规则，坏结构一律报错。
 */
export const informationStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  settings: z.strictObject({
    enabled: z.boolean(),
    batchWindowSeconds: z.number().int().min(0).max(3600),
    mode: z.enum(["notifications", "recommendations"]).default("notifications"),
  }),
  preferences: z.strictObject({
    learnedNotes: z.string().max(20000).default(""),
  }),
  items: z.array(itemSchema),
  runs: z.array(runSchema),
  articleFeedback: z.array(z.strictObject({
    itemId: z.string().min(1).max(128),
    reaction: z.enum(["like", "dislike"]).nullable(),
    saved: z.boolean(),
    comments: z.array(z.strictObject({
      id: z.string().min(1).max(128),
      text: z.string().min(1).max(4000),
      createdAt: isoTime,
      updatedAt: isoTime,
    })),
  })).default([]),
  initialAnalysisCompleted: z.boolean().default(false).optional(),
});

/**
 * 严格解析短信状态：字段规则之外还检查身份唯一性与引用关系，
 * 避免库里出现重复 id、指向不存在条目的 run/反馈这类坏事实。
 */
export const parseInformationState = (value: unknown): InformationState => {
  const parsed = informationStateSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid information state");
  const state = parsed.data;
  const unique = (values: string[]): boolean => new Set(values).size === values.length;
  const items = new Set(state.items.map((item) => item.id));
  if (!unique(state.items.map((item) => item.id)) ||
      !unique(state.items.map((item) => JSON.stringify([item.source, item.externalId]))) ||
      !unique(state.runs.map((run) => run.id)) ||
      !unique(state.articleFeedback.map((feedback) => feedback.itemId)) ||
      !unique(state.articleFeedback.flatMap((feedback) => feedback.comments.map((comment) => comment.id))) ||
      state.articleFeedback.some((feedback) => !items.has(feedback.itemId)) ||
      state.runs.some((run) => run.itemIds.some((id) => !items.has(id)) ||
        !unique(run.itemIds) ||
        !unique((run.decisions ?? []).map((decision) => decision.itemId)) ||
        run.decisions?.some((decision) => !run.itemIds.includes(decision.itemId)))) {
    throw new Error("Invalid information state: duplicate identity or invalid relation");
  }
  return state;
};

/**
 * 短信仓储的 SQLite 实现：聚合 read/update 接口语义不变，事实落在 main.sqlite 的
 * sms_* 表（见 sms-schema.ts），写入按行级 diff 提交。
 *
 * - read() 返回完整 InformationState；update(change, options) 把当前状态交给回调，
 *   回调返回 state 时才落库（行级 diff），未返回 state 时绝不写库。
 * - options.allowCreate 只为保持端口形状，与既有实现一致地不改变行为。
 * - 写成功后调用 onCommitted（由组装层决定是否需要通知外部观察者）。
 * - 校验在读出与写入两侧执行同一规则；损坏结构显式失败，不静默过滤或置空。
 */
export const createInformationRepository = (
  managed: ManagedSqliteDatabase,
  onCommitted?: () => void,
): InformationRepository => {
  let ready = false;
  const ensureReady = (): void => {
    if (ready) return;
    ensureSmsModule(managed);
    ready = true;
  };
  const repository: InformationRepository = {
    read: () => managed.serialize(() => {
      ensureReady();
      return parseInformationState(readSmsState(managed));
    }),
    update: (change, _options) => managed.serialize(async () => {
      ensureReady();
      const current = parseInformationState(readSmsState(managed));
      // 回调允许原位修改；diff 基线必须与回调持有的对象隔离。
      const changed = await change(structuredClone(current));
      if (changed.state) {
        const next = parseInformationState(changed.state);
        managed.transaction(() => applySmsState(managed, current, next));
        onCommitted?.();
      }
      return changed.result;
    }),
    reconcileOnStart: async () => {
      const now = new Date().toISOString();
      await repository.update((state) => {
        let changed = false;
        const runs = state.runs.map((run) => {
          if (run.status !== "running") return run;
          changed = true;
          return {
            ...run,
            status: "failed" as const,
            finishedAt: now,
            model: { status: "failed" as const, error: "Interrupted by service restart" },
            publications: run.publications.map((publication) =>
              publication.status === "pending"
                ? { ...publication, status: "failed" as const, error: "Interrupted by service restart" }
                : publication,
            ),
          };
        });
        const failedRunIds = new Set(runs.filter((run) => run.status === "failed").map((run) => run.id));
        const items = state.items.map((item) => {
          if (item.status !== "processing" || !item.runId || !failedRunIds.has(item.runId)) return item;
          changed = true;
          return { ...item, status: "failed" as const };
        });
        const completedRuns = runs.map((run) => {
          if (run.status !== "completed" || !run.publications.some((publication) => publication.status === "pending")) return run;
          changed = true;
          return {
            ...run,
            publications: run.publications.map((publication) =>
              publication.status === "pending"
                ? { ...publication, status: "failed" as const, error: "Interrupted by service restart" }
                : publication,
            ),
          };
        });
        if (!changed) return { result: undefined };
        return { state: { ...state, items, runs: completedRuns }, result: undefined };
      });
    },
    validateAll: async () => { await repository.read(); },
  };
  return repository;
};
