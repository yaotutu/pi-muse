import type { WebSearchResult } from "../../../../features/web/types.js";
import { decodeEntities, isPublicHttpUrl, stripHtmlToText } from "../parse-helpers.js";
import type { SearchSource } from "../types.js";

const duckDuckGoEndpoint = "https://html.duckduckgo.com/html/";
const bingRssEndpoint = "https://www.bing.com/search?format=rss";

const resultUrl = (href: string) => {
  const decoded = decodeEntities(href);
  const absolute = new URL(decoded, "https://duckduckgo.com");
  const target = absolute.searchParams.get("uddg");
  if (target) return target;
  return absolute.toString();
};

/** 解析 DuckDuckGo HTML 的轻量函数；不引入 DOM 依赖，也避免执行页面脚本。 */
export const parseDuckDuckGoResults = (html: string, count: number): WebSearchResult[] => {
  const anchors = [
    ...html.matchAll(/<a\s[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi),
  ];
  return anchors.slice(0, count).map((anchor, index) => {
    const next = anchors[index + 1];
    const block = html.slice(anchor.index ?? 0, next?.index ?? html.length);
    const snippet =
      /<a\s[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ??
      "";
    const url = resultUrl(anchor[1]!);
    if (!/^https?:/i.test(url)) return undefined;
    return {
      title: stripHtmlToText(anchor[2]!),
      url,
      snippet: stripHtmlToText(snippet),
    };
  }).filter((item): item is WebSearchResult => item !== undefined);
};

/** Bing RSS 是无密钥兜底；DuckDuckGo 在部分网络会被 anomaly challenge 拦截。 */
export const parseBingRssResults = (xml: string, count: number): WebSearchResult[] =>
  [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, count)
    .map((item) => {
      const value = (tag: string) =>
        stripHtmlToText(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(item[1]!)?.[1] ?? "");
      return { title: value("title"), url: value("link"), snippet: value("description") };
    })
    .filter((item) => isPublicHttpUrl(item.url));

export const duckDuckGoSearchSource: SearchSource = {
  id: "duckduckgo",
  search: async (query, count, context, signal) => {
    signal?.throwIfAborted();
    try {
      const url = new URL(duckDuckGoEndpoint);
      url.searchParams.set("q", query);
      const page = await context.request(url.toString(), context.http, signal);
      if (page.contentType.toLowerCase().includes("html")) {
        const results = parseDuckDuckGoResults(page.body, count);
        if (results.length) return results;
      }
    } catch {
      signal?.throwIfAborted();
    }
    signal?.throwIfAborted();
    const url = new URL(bingRssEndpoint);
    url.searchParams.set("q", query);
    const page = await context.request(url.toString(), context.http, signal);
    return parseBingRssResults(page.body, count);
  },
};
