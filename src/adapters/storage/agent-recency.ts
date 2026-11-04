import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { writeJsonDocument } from "./json-document.js";

/** 最近有效活动独立于会话文件 mtime；查看设置、编辑规则或流式 token 不改变头像顺序。 */
export const loadAgentRecency = async (file: string) => {
  let initial: Record<string, string>;
  try { initial = z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), z.iso.datetime()).parse(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid agent recency document");
    initial = {};
  }
  const serialized = createSerializedWriter();
  let pending: Promise<void> = Promise.resolve();
  let failed = false;
  return {
    initial,
    save: (value: Record<string, string>) => {
      pending = serialized(() => writeJsonDocument(file, value)).then(() => { failed = false; }, () => { failed = true; });
    },
    flush: async () => { await pending; if (failed) throw new Error("Could not save agent recency"); },
  };
};
