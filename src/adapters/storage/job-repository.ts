import type { JobRepository } from "../../features/jobs/ports.js";
import type { Job } from "../../features/jobs/types.js";
import { applyJobs, parseJobs, readJobs } from "./jobs-schema.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";

export { jobsModule } from "./jobs-schema.js";

/**
 * 定时任务 repository 的 SQLite 实现。
 *
 * 端口语义与旧 JSON 实现保持一致：
 * - read() 返回当前全部任务，顺序与旧文档数组顺序一致（由 position 列稳定保序）。
 * - update(change) 在同一个 serialize 单元内读取当前状态、调用回调；回调返回 items 时
 *   才按行级 diff 提交，返回 result 但不返回 items 时绝不写库（纯查询或未命中）。
 * - 写成功后调用 onCommitted 通知客户端重新读取；通知失败不回滚已经提交的数据。
 *
 * 事务边界：回调在事务外执行，事务内只有同步 SQL；模型、网络与人工决定都不进入事务。
 */
export const createJobRepository = (
  managed: ManagedSqliteDatabase,
  onCommitted?: () => void,
): JobRepository => ({
  read: () => managed.serialize(() => readJobs(managed)),
  update: <T>(
    change: (items: Job[]) => { items?: Job[]; result: T },
  ): Promise<T> =>
    managed.serialize(async () => {
      const previous = readJobs(managed);
      // 回调拿到的是与库内快照隔离的副本，原位修改不会污染 diff 基线。
      const changed = await change(structuredClone(previous));
      // 未返回 items 表示纯查询或未命中，绝不写库。
      if (changed.items !== undefined) {
        const next = parseJobs(changed.items);
        managed.transaction(() => applyJobs(managed, previous, next));
        // 同一提交点覆盖 HTTP、工具和调度器；通知失败不能否认已经落盘的结果。
        try { onCommitted?.(); } catch { /* 通知仅用于让客户端重新读取。 */ }
      }
      return changed.result;
    }),
});
