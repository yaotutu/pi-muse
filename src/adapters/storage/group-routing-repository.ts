import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { RoutingRepository } from "../../features/group-chat/routing.js";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { writeJsonDocument } from "./json-document.js";

const agentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const groupSettingsSchema = z.strictObject({ name: z.string().trim().min(1).max(80), purpose: z.string().max(1000),
  memberIds: z.array(agentId).min(1).max(100), defaultAgentId: agentId, instructions: z.string().max(4000) });
const schema = z.strictObject({ group: groupSettingsSchema.nullable(), capabilities: z.record(agentId, z.string().max(1000)) });

/** 只保存组配置和公开能力，不复制聊天正文；旧索引不迁移，缺失配置按当前目录给出默认值。 */
export const createGroupRoutingRepository = (file: string): RoutingRepository => {
  const serial = createSerializedWriter();
  const read = async () => {
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { group: null, capabilities: {} }; throw error; }
    try {
      const value = schema.parse(JSON.parse(text));
      if (value.group && (!value.group.memberIds.includes(value.group.defaultAgentId) || new Set(value.group.memberIds).size !== value.group.memberIds.length)) throw new Error();
      return value;
    } catch { throw new Error("Invalid group routing document"); }
  };
  return { read: () => serial(read), update: (change) => serial(async () => { await writeJsonDocument(file, schema.parse(change(await read()))); }) };
};
