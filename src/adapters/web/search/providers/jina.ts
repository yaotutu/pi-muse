import type { WebSearchResult } from "../../../../features/web/types.js";
import { extractJsonItems, isRecord } from "../parse-helpers.js";
import type { SearchSource } from "../types.js";

const jinaSearchBase = "https://s.jina.ai/";

export const parseJinaSearchResults = (payload: unknown, count: number): WebSearchResult[] => {
  if (!isRecord(payload)) return [];
  return extractJsonItems(payload.data, count, (item) => ({
    title: item.title,
    url: item.url,
    snippet: item.description ?? item.content ?? item.snippet,
  }));
};

export const jinaSearchSource: SearchSource = {
  id: "jina",
  search: async (query, count, context, signal) => {
    const endpoint = `${jinaSearchBase}${encodeURIComponent(query)}`;
    const page = await context.request(
      endpoint,
      context.http,
      signal,
      {
        headers: {
          accept: "application/json",
          ...(context.search?.apiKey ? { authorization: `Bearer ${context.search.apiKey}` } : {}),
        },
      },
    );
    return parseJinaSearchResults(JSON.parse(page.body), count);
  },
};
