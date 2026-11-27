import { lstat, readFile } from "node:fs/promises";
import { SUBAGENT_ID_PATTERN, type SubagentSettingsRepository } from "../../features/subagents/types.js";
import type { DataLayout } from "./data-layout.js";
import { writeJsonDocument } from "./json-document.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const ensureNotSymlink = async (file: string): Promise<boolean> => {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Subagent settings file must be a regular file");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/** 持久化各 Subagent 的统一启用覆盖配置（DATA_DIR/state/subagent-settings.json）。 */
export const createSubagentSettingsRepository = (
  layout: Pick<DataLayout, "subagentSettingsFile">,
): SubagentSettingsRepository => {
  const file = layout.subagentSettingsFile;
  return {
    load: async () => {
      const exists = await ensureNotSymlink(file);
      if (!exists) return {};
      const raw = await readFile(file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed.enabled)) {
        throw new Error("Invalid subagent settings document");
      }
      const enabled: Record<string, boolean> = {};
      for (const [id, value] of Object.entries(parsed.enabled)) {
        if (!SUBAGENT_ID_PATTERN.test(id) || typeof value !== "boolean") {
          throw new Error("Invalid subagent setting entry");
        }
        enabled[id] = value;
      }
      return enabled;
    },
    save: async (enabled: Record<string, boolean>) => {
      await ensureNotSymlink(file);
      await writeJsonDocument(file, { enabled });
    },
  };
};
