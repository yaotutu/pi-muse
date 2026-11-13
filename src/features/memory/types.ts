import type { Identity } from "../identity/types.js";

export type MemoryItem = {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * memory.md 的业务形状：只有记忆条目。
 * 身份设置已拆到 identity.json，不再和记忆共用同一个文档或写队列。
 */
export type MemoryState = {
  memories: MemoryItem[];
};

/** 提示词渲染视图：记忆条数与身份设置。记忆正文不逐条进入上下文。 */
export type MemoryPromptState = {
  memories: MemoryItem[];
  identity: Identity;
};

export type MemoryRepository = {
  read: () => Promise<MemoryState>;
  /**
   * 在 repository 自己的串行队列中执行一次完整读改写。
   * 未返回 state 表示此次只读/未命中，不应触碰磁盘文件。
   */
  update: <T>(
    change: (state: MemoryState) => { state?: MemoryState; result: T },
  ) => Promise<T>;
};

/**
 * identity.json 的存储端口。身份是配置型文档，和记忆分属两个 repository、
 * 两个写队列，任一方都不会覆盖另一方的文件。
 */
export type IdentityRepository = {
  read: () => Promise<Identity>;
  update: <T>(
    change: (identity: Identity) => { state?: Identity; result: T },
  ) => Promise<T>;
};

/** 提示词渲染只需要读身份；记忆写入不经过这个端口。 */
export type IdentityReader = {
  get: () => Promise<Identity>;
};
