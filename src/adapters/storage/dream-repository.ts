import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultDreamState, type DreamRepository, type DreamState } from "../../features/dream/types.js";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import type { DataLayout } from "./data-layout.js";
import { InvalidDocumentError, readDreamDocument } from "./document-schemas.js";
import { writeJsonDocument } from "./json-document.js";
import { readProfileFile, writeProfileFile } from "./profile-files.js";

export type DreamStorage = DreamRepository & {
  readGlobalPrompt(): Promise<string>;
  writeGlobalPrompt(content: string): Promise<void>;
  reconcileOnStart(): Promise<void>;
};
/** 全局状态只保留一份；配置提示词固定为 profile/DREAM.md。 */
export const createDreamRepository = (layout: DataLayout): DreamStorage => {
  const serial = createSerializedWriter();
  const file = join(layout.profileDir, "dream.json");
  const read = async (): Promise<DreamState> => {
    let source: string;
    try { source = await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultDreamState(); throw error; }
    let value: unknown;
    try { value = JSON.parse(source); } catch { throw new InvalidDocumentError("dream"); }
    return readDreamDocument(value);
  };
  const repository: DreamStorage = {
    read: () => serial(read),
    update: (change) => serial(async () => {
      const changed = change(await read());
      if (changed.state) {
        await mkdir(layout.profileDir, { recursive: true, mode: 0o700 });
        await writeJsonDocument(file, readDreamDocument(changed.state));
      }
      return changed.result;
    }),
    readGlobalPrompt: () => readProfileFile(layout.dreamFile),
    writeGlobalPrompt: async (content) => { await writeProfileFile(layout.dreamFile, content); },
    reconcileOnStart: async () => {
      await repository.update((state) => state.lastRun?.status !== "running" ? { result: undefined } : {
        state: { ...state, lastRun: { ...state.lastRun, status: "failed", error: "Interrupted by service restart" } }, result: undefined,
      });
    },
  };
  return repository;
};
