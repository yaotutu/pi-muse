import type { DreamRepository } from "../../features/dream/types.js";
import { applyDreamState, ensureDreamModule, parseDreamState, readDreamState } from "./dream-schema.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";

/**
 * Dream 状态仓储：机器状态与待确认建议在 main.sqlite 的 dream_* 表中维护；
 * Dream 系统提示词统一托管在仓库 `prompts/dream/` 目录。
 */
export type DreamStorage = DreamRepository & {
  reconcileOnStart(): Promise<void>;
};

/**
 * 仓储语义与既有实现一致：
 * - read() 返回完整 DreamState；
 * - update(change) 把当前状态交给回调，回调返回 state 时才落库（行级 diff），
 *   未返回 state 时绝不写库；
 * - 写成功后调用 onCommitted；
 * - reconcileOnStart() 把中断的整理轮诚实标记为 failed，不推进游标、不自动重跑。
 */
export const createDreamRepository = (
  managed: ManagedSqliteDatabase,
  onCommitted?: () => void,
): DreamStorage => {
  let ready = false;
  const ensureReady = (): void => {
    if (ready) return;
    ensureDreamModule(managed);
    ready = true;
  };
  const repository: DreamStorage = {
    read: () => managed.serialize(() => {
      ensureReady();
      return readDreamState(managed);
    }),
    update: (change) => managed.serialize(async () => {
      ensureReady();
      const current = readDreamState(managed);
      // 回调允许原位修改；diff 基线必须与回调持有的对象隔离。
      const changed = await change(structuredClone(current));
      if (changed.state) {
        const next = parseDreamState(changed.state);
        managed.transaction(() => applyDreamState(managed, current, next));
        onCommitted?.();
      }
      return changed.result;
    }),
    reconcileOnStart: async () => {
      await repository.update((state) => state.lastRun?.status !== "running" ? { result: undefined } : {
        state: { ...state, lastRun: { ...state.lastRun, status: "failed", error: "Interrupted by service restart" } },
        result: undefined,
      });
    },
  };
  return repository;
};
