import type { NewsRepository } from "../../features/news/types.js";
import type { InformationRepository } from "../../features/information/types.js";

/** 新闻处理事实嵌入 news.json；复用同一 repository 队列，不开第二个 writer。 */
export const createNewsProcessingRepository = (news: NewsRepository): InformationRepository => {
  const repository: InformationRepository = {
    read: async () => (await news.read()).processing,
    update: (change) => news.update(async (state) => {
      const changed = await change(state.processing);
      return { state: changed.state ? { ...state, processing: changed.state } : undefined, result: changed.result };
    }),
    validateAll: () => news.validate(),
    reconcileOnStart: async () => {
      await repository.update((state) => {
        const interrupted = state.runs.some((r) => r.status === "running" || r.publications.some((p) => p.status === "pending"));
        if (!interrupted) return { result: undefined };
        return { state: { ...state,
          items: state.items.map((item) => item.status === "processing" ? { ...item, status: "failed" } : item),
          runs: state.runs.map((run) => ({ ...run,
            ...(run.status === "running" ? { status: "failed" as const, finishedAt: new Date().toISOString(), model: { status: "failed" as const, error: "Interrupted by service restart" } } : {}),
            publications: run.publications.map((p) => p.status === "pending" ? { ...p, status: "failed" as const, error: "Interrupted by service restart" } : p),
          })),
        }, result: undefined };
      });
    },
  };
  return repository;
};
