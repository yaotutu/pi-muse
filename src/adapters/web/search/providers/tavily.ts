import type { WebSearchResult } from "../../../../features/web/types.js";
import { extractJsonItems, isRecord } from "../parse-helpers.js";
import type { SearchSource } from "../types.js";

const defaultTavilyEndpoint = "https://api.tavily.com/search";

export const parseTavilyResults = (payload: unknown, count: number): WebSearchResult[] => {
  if (!isRecord(payload)) return [];
  return extractJsonItems(payload.results, count, (item) => ({
    title: item.title,
    url: item.url,
    snippet: item.content ?? item.snippet,
  }));
};

export const tavilySearchSource: SearchSource = {
  id: "tavily",
  search: async (query, count, context, signal) => {
    const endpoint = context.search?.baseUrl || defaultTavilyEndpoint;
    const page = await context.request(
      endpoint,
      context.http,
      signal,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          api_key: context.search?.apiKey,
          query,
          max_results: count,
          search_depth: "basic",
        }),
      },
    );
    return parseTavilyResults(JSON.parse(page.body), count);
  },
};
