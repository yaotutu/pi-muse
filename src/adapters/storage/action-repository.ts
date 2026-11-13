import { actionFromRow, applyActionsDiff, readActionRows } from "./actions-schema.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import type { ActionRepository, PendingAction } from "../../features/actions/types.js";
import { readActionsDocument } from "./document-schemas.js";

/**
 * 审批记录的 SQLite 仓储实现。
 *
 * 端口语义与旧 JSON 仓储保持一致：
 * - read() 返回全部审批记录，按 position 保序（与旧裸数组的写入顺序同形）。
 * - update(change) 在同一串行单元内读出记录、调用回调；回调返回 items 时按行级
 *   diff 提交（只动变化行与变化列），不返回 items 时绝不写库。
 * - 提交成功后调用 onCommitted；通知失败不影响已经提交的数据。
 *
 * 领域层（features/actions）零改动：状态迁移、过期判定与执行回执的语义都由
 * 领域服务决定，仓储只负责按端口存取，并让数据库约束拒绝非法状态组合。
 */
export const createActionRepository = (
  managed: ManagedSqliteDatabase,
  onCommitted?: () => void,
): ActionRepository => ({
  read: () => managed.serialize(() => readActionRows(managed).map(actionFromRow)),
  update: <T>(
    change: (items: PendingAction[]) => { items?: PendingAction[]; result: T },
  ): Promise<T> =>
    managed.serialize(async () => {
      const previous = readActionRows(managed);
      // 回调拿到的是与库内快照隔离的副本：回调可以原地修改，diff 基线不受影响。
      const draft = previous.map(actionFromRow);
      const changed = await change(draft);
      // 未返回 items 表示纯查询或未命中，绝不写库。
      if (changed.items !== undefined) {
        managed.transaction(() => applyActionsDiff(managed, previous, changed.items as PendingAction[]));
        // 同一提交点覆盖 HTTP、工具和调度器；通知失败不能否认已经落盘的结果。
        try { onCommitted?.(); } catch { /* 通知仅用于让客户端重新读取。 */ }
      }
      return changed.result;
    }),
});
