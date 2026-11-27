import type { WebSearchResult } from "../../../../features/web/types.js";
import { extractJsonItems, isRecord } from "../parse-helpers.js";
import type { SearchSource } from "../types.js";

const defaultBraveEndpoint = "https://api.search.brave.com/res/v1/web/search";

export const parseBraveResults = (payload: unknown, count: number): WebSearchResult[] => {
  if (!isRecord(payload) || !isRecord(payload.web)) return [];
  return extractJsonItems(payload.web.results, count, (item) => ({
    title: item.title,
    url: item.url,
    snippet: item.description ?? item.snippet,
  }));
};

export const braveSearchSource: SearchSource = {
  id: "brave",
  search: async (query, count, context, signal) => {
    const endpoint = new URL(context.search?.baseUrl || defaultBraveEndpoint);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("count", String(count));
    const page = await context.request(
      endpoint.toString(),
      context.http,
      signal,
      {
        headers: {
          accept: "application/json",
          "x-subscription-token": context.search?.apiKey ?? "",
        },
      },
    );
    return parseBraveResults(JSON.parse(page.body), count);
  },
};
