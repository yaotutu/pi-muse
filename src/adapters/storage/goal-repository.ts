import { applyGoals, ensureGoalsModule, parseGoals, readGoals } from "./goals-schema.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import type { Goal, GoalRepository } from "../../features/goals/types.js";

/**
 * 目标仓储的 SQLite 实现：聚合 read/update 接口保持端口语义不变，
 * 写入按行级 diff 提交（见 goals-schema.ts）。
 *
 * 与旧 goals.json 的语义对齐：
 * - read() 返回按 position 保序的目标数组，等价于旧文档的数组顺序。
 * - update() 在同一次串行读改写里读出当前值交给回调；回调没有返回 items 时
 *   表示纯查询或未命中，绝不写库；返回 items 时先做领域严格校验再提交差异。
 * - 提交成功后调用 onCommitted；通知失败不能否认已经落盘的结果，也不回滚数据。
 */
export const createGoalRepository = (
  managed: ManagedSqliteDatabase,
  onCommitted?: () => void,
): GoalRepository => {
  // 结构缺失或版本不符时明确失败，不静默当成空目标集。
  ensureGoalsModule(managed);
  return {
    read: (): Promise<Goal[]> => managed.serialize(() => readGoals(managed)),
    update: <T>(change: (items: Goal[]) => { items?: Goal[]; result: T }): Promise<T> =>
      managed.serialize(() => {
        const current = readGoals(managed);
        // 回调允许原位修改；diff 基线必须与回调持有的对象隔离。
        const changed = change(structuredClone(current));
        // 未返回 items 表示纯查询或未命中，绝不写库。
        if (changed.items !== undefined) {
          const next = parseGoals(changed.items);
          managed.transaction(() => applyGoals(managed, current, next));
          // 同一提交点覆盖 HTTP、工具和调度器；通知失败不能否认已经落盘的结果。
          try {
            onCommitted?.();
          } catch {
            /* 通知仅用于让客户端重新读取。 */
          }
        }
        return changed.result;
      }),
  };
};
