import { readFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isSessionId, sessionDir, sessionInstructionsFile, type DataLayout } from "./data-layout.js";
import { writeJsonDocument } from "./json-document.js";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import type { SessionRecord, SessionRepository, SessionStorage } from "../../features/sessions/types.js";

const validate = (value: unknown): SessionRecord[] => {
  if (!Array.isArray(value)) throw new Error("Invalid sessions document");
  const ids = new Set<string>();
  for (const record of value) {
    if (!record || typeof record !== "object" || !isSessionId(record.id) || ids.has(record.id) ||
      typeof record.title !== "string" || !record.title.trim() || record.title.length > 200 ||
      typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) ||
      typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt)) ||
      record.isMain !== (record.id === "main") || (record.isMain && record.title !== "默认会话")) throw new Error("Invalid sessions document");
    ids.add(record.id);
  }
  return value as SessionRecord[];
};
export const createSessionRepository = (file: string): SessionRepository => {
  const serial = createSerializedWriter();
  const read = async () => {
    let source: string;
    try { source = await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return validate(JSON.parse(source));
  };
  return {
    read,
    update: (change) => serial(async () => {
      const result = change(await read());
      if (result.sessions !== undefined) await writeJsonDocument(file, validate(result.sessions));
      return result.result;
    }),
  };
};
export const initializeMainSession = async (repository: SessionRepository, storage: SessionStorage) => {
  await storage.initialize("main");
  await repository.update((sessions) => {
    if (sessions.some((s) => s.id === "main")) return { result: undefined };
    const timestamp = new Date().toISOString();
    return { sessions: [...sessions, { id: "main", title: "默认会话", isMain: true, createdAt: timestamp, updatedAt: timestamp }], result: undefined };
  });
};
export const createSessionStorage = (layout: DataLayout): SessionStorage => ({
  initialize: async (id) => { await mkdir(sessionDir(layout, id), { recursive: true, mode: 0o700 }); },
  clearHistory: async (id) => {
    for (const name of await readdir(sessionDir(layout, id))) {
      if (name.endsWith(".jsonl")) await rm(join(sessionDir(layout, id), name));
    }
  },
  remove: async (id) => { await rm(sessionDir(layout, id), { recursive: true, force: true }); },
});
