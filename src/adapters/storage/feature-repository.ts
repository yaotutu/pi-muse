import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { defaultFeatureState, isFeatureSpace, type FeatureRepository, type FeatureState } from "../../features/feature-spaces/types.js";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { writeJsonDocument } from "./json-document.js";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).refine((value) => !isFeatureSpace(value));
const schema = z.strictObject({
  schemaVersion: z.literal(1),
  bindings: z.strictObject({ news: id, sms: id }),
  links: z.array(z.strictObject({ featureId: z.enum(["news", "sms"]), itemIds: z.array(z.string().min(1).max(128)).min(1).max(20), spaceId: id, sessionId: z.string().min(1).max(128), messageId: z.string().min(1).max(200) })),
});
const parse = (value: unknown): FeatureState => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid feature document");
  return parsed.data;
};
/** 只保存绑定与消息关联，不复制 PI 正文、反馈或功能原始内容。 */
export const createFeatureRepository = (file: string): FeatureRepository => {
  const serial = createSerializedWriter();
  const read = async () => {
    let text: string;
    try { text = await readFile(file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultFeatureState();
      throw error;
    }
    try { return parse(JSON.parse(text)); } catch { throw new Error("Invalid feature document"); }
  };
  return {
    read: () => serial(read),
    update: (change) => serial(async () => {
      const changed = change(await read());
      const state = parse(changed.state);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeJsonDocument(file, state);
      return changed.result;
    }),
  };
};
