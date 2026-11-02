import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { GroupRepository } from "../../features/group-chat/service.js";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { writeJsonDocument } from "./json-document.js";

const spaceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const schema = z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), rootId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), sourceSpaceId: spaceId.nullable(), targetSpaceId: spaceId,
  discussionId: z.uuid(), createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(), status: z.enum(["running", "completed", "failed", "cancelled"]) }));

/** 索引不含用户消息或回复正文；仅缺失文件可初始化，损坏数据必须报错。 */
export const createGroupRepository = (file: string): GroupRepository => {
  const serial = createSerializedWriter();
  const read = async () => {
    let text: string;
    try { text = await readFile(file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const items = schema.parse(JSON.parse(text));
      if (new Set(items.map((turn) => turn.id)).size !== items.length) throw new Error();
      return items;
    } catch { throw new Error("Invalid group document"); }
  };
  return { read: () => serial(read), update: (change) => serial(async () => { await writeJsonDocument(file, schema.parse(change(await read()))); }) };
};
