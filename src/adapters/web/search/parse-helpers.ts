import type { WebSearchResult } from "../../../features/web/types.js";

export const decodeEntities = (value: string) =>
  value
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)));

const normalizeText = (value: string) =>
  value.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

export const stripHtmlToText = (html: string) =>
  normalizeText(
    decodeEntities(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );

export const isPublicHttpUrl = (value: unknown): value is string =>
  typeof value === "string" && (value.startsWith("http://") || value.startsWith("https://"));

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** 统一从各类 JSON 搜索响应数组中抽取并过滤公网 HTTP(S) 结果。 */
export const extractJsonItems = (
  items: unknown,
  count: number,
  mapItem: (item: Record<string, unknown>) => { title?: unknown; url?: unknown; snippet?: unknown },
): WebSearchResult[] => {
  if (!Array.isArray(items)) return [];
  const results: WebSearchResult[] = [];
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const mapped = mapItem(raw);
    if (!isPublicHttpUrl(mapped.url)) continue;
    results.push({
      title: typeof mapped.title === "string" ? mapped.title.trim() : "",
      url: mapped.url,
      snippet: typeof mapped.snippet === "string" ? mapped.snippet.trim() : "",
    });
    if (results.length >= count) break;
  }
  return results;
};
