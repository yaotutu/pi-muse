import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { defaultIdentity, type Identity } from "../../features/identity/types.js";
import type { IdentityRepository } from "../../features/memory/types.js";

import { readIdentityDocument, InvalidDocumentError } from "./document-schemas.js";
import { writeJsonDocument } from "./json-document.js";

/**
 * 只有缺失文件可以初始化为默认身份；权限、JSON/形状损坏都阻止后续读改写。
 * identity.json 是配置型文档，四个字段必须齐全且类型正确，不补默认值。
 */
const readIdentity = async (file: string): Promise<Identity> => {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaultIdentity };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new InvalidDocumentError("identity"); }
  return readIdentityDocument(value);
};

/**
 * 身份设置的独立存储（DATA_DIR/profile/identity.json）。
 *
 * 与长期记忆分属不同文档、不同写队列：任一方的写入都不会覆盖另一方的文件，
 * 也不需要共享锁来避免互相回写旧值。
 */
export const createIdentityRepository = (file: string, onCommitted?: () => void): IdentityRepository => {
  const serialized = createSerializedWriter();
  return {
    read: () => readIdentity(file),
    update: (change) =>
      serialized(async () => {
        const identity = await readIdentity(file);
        const changed = change(identity);
        if (changed.state) {
          await mkdir(dirname(file), { recursive: true, mode: 0o700 });
          await writeJsonDocument(file, changed.state);
          // 通知错误不回滚已落盘的数据；客户端重连后会重新同步。
          try { onCommitted?.(); } catch { /* 客户端重连后会重新同步。 */ }
        }
        return changed.result;
      }),
  };
};
