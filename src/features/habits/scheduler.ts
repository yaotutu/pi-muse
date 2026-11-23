import { HABIT_CONSOLIDATION_INTERVAL_MS } from "../../features/habits/types.js";
import type { HabitsService } from "./service.js";

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export type HabitsScheduler = {
  start: () => void;
  close: () => Promise<void>;
};

/**
 * 习惯定时归纳调度器：默认每分钟轮询各领域到期状态（2 小时兜底归纳一次），
 * 由 bootstrap 唯一启动与关闭，关闭时等待在途归纳安全结束。
 */
export const createHabitsScheduler = (
  habits: Pick<HabitsService, "runDue" | "close">,
  options?: { pollIntervalMs?: number; intervalMs?: number },
): HabitsScheduler => {
  const pollIntervalMs = options?.pollIntervalMs ?? Math.min(DEFAULT_POLL_INTERVAL_MS, options?.intervalMs ?? HABIT_CONSOLIDATION_INTERVAL_MS);
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let runningTick: Promise<void> | undefined;
  const controller = new AbortController();

  const tick = () => {
    if (closed || runningTick) return;
    runningTick = habits
      .runDue(controller.signal)
      .catch(() => undefined)
      .finally(() => {
        runningTick = undefined;
      });
  };

  return {
    start: () => {
      if (closed || timer) return;
      timer = setInterval(tick, pollIntervalMs);
      timer.unref();
    },
    close: () => {
      if (closing) return closing;
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      controller.abort();
      closing = (async () => {
        await runningTick;
        await habits.close();
      })();
      return closing;
    },
  };
};
