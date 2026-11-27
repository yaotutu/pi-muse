import type { WebSearchResult } from "../../../../features/web/types.js";
import { extractJsonItems, isRecord } from "../parse-helpers.js";
import type { SearchSource } from "../types.js";

export const parseSearxngResults = (payload: unknown, count: number): WebSearchResult[] => {
  if (!isRecord(payload)) return [];
  return extractJsonItems(payload.results, count, (item) => ({
    title: item.title,
    url: item.url,
    snippet: item.content ?? item.snippet,
  }));
};

export const searxngSearchSource: SearchSource = {
  id: "searxng",
  search: async (query, count, context, signal) => {
    const baseUrl = context.search?.baseUrl;
    if (!baseUrl) throw new Error("SearXNG baseUrl missing");
    const endpoint = new URL(`${baseUrl}/search`);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    // SearXNG 常见为管理员自建私网/本地服务，仅本次显式配置的实例放行目标主机。
    const page = await context.request(
      endpoint.toString(),
      { ...context.http, allowPrivateTargets: true },
      signal,
      { headers: { accept: "application/json" } },
    );
    return parseSearxngResults(JSON.parse(page.body), count);
  },
};
