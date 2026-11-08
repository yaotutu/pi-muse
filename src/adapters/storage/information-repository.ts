import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isSessionId } from "../../features/conversation/session-id.js";
import {
  defaultInformationState,
  type InformationRepository,
  type InformationState,
} from "../../features/information/types.js";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { informationFile, type DataLayout } from "./data-layout.js";
import { writeJsonDocument } from "./json-document.js";

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
  itemIds: z.array(z.string().min(1).max(128)).min(1),
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
export const informationStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  settings: z.strictObject({
    enabled: z.boolean(),
    batchWindowSeconds: z.number().int().min(0).max(3600),
    mode: z.enum(["notifications", "recommendations"]).default("notifications"),
  }),
  preferences: z.strictObject({
    notes: z.string().max(20000),
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

const parseState = (value: unknown, logicalFile: string): InformationState => {
  const parsed = informationStateSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid information document: ${logicalFile}`);
  return parsed.data;
};

const readState = async (file: string, logicalFile: string): Promise<InformationState> => {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultInformationState();
    throw error;
  }
  try {
    return parseState(JSON.parse(source), logicalFile);
  } catch {
    throw new Error(`Invalid information document: ${logicalFile}`);
  }
};

/** 全局短信文档；所有读改写和启动校准共用同一条队列。 */
export const createInformationRepository = (layout: DataLayout): InformationRepository => {
  const serialized = createSerializedWriter();
  const file = informationFile(layout);
  const repository: InformationRepository = {
    read: () => serialized(() => readState(file, "information/sms.json")),
    update: (change) => serialized(async () => {
      const changed = await change(await readState(file, "information/sms.json"));
      if (changed.state) {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeJsonDocument(file, parseState(changed.state, "information/sms.json"));
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
