import { readFile } from "node:fs/promises";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import type { MemoryItem, MemoryRepository, MemoryState } from "../../features/memory/types.js";

import { parseMemoryMarkdown, writeMemoryMarkdown } from "./memory-markdown.js";

/**
 * 只有缺失文件可以初始化为空记忆集；权限、格式损坏都阻止后续读改写。
 * 损坏的 memory.md 抛 InvalidDocumentError("memory-markdown")，不静默清空。
 */
const readMemories = async (file: string): Promise<MemoryItem[]> => {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseMemoryMarkdown(source);
};

/**
 * 长期记忆的纯文本存储（DATA_DIR/profile/memory.md）。
 *
 * 记忆是人可读可改的清单，不再和身份设置共用文档或写队列：
 * 身份在 identity.json 由自己的 repository 负责，两者互不覆盖。
 */
export const createMemoryRepository = (file: string, onCommitted?: () => void): MemoryRepository => {
  const serialized = createSerializedWriter();
  return {
    read: async (): Promise<MemoryState> => ({ memories: await readMemories(file) }),
    update: (change) =>
      serialized(async () => {
        const memories = await readMemories(file);
        const changed = change({ memories });
        if (changed.state) {
          await writeMemoryMarkdown(file, changed.state.memories);
          // 通知错误不回滚已落盘的数据；客户端重连后会重新同步。
          try { onCommitted?.(); } catch { /* 客户端重连后会重新同步。 */ }
        }
        return changed.result;
      }),
  };
};
