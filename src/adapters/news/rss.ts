import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { NewsSourceError } from "../../features/news/errors.js";
import { safePublicGet } from "../web/http-transport.js";
import type { ParsedFeed, ParsedFeedItem } from "../../features/news/types.js";

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_ITEMS = 500;

const normalize = (value: string) =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const decodeEntities = (value: string) =>
  value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    const named: Record<string, string> = {
      amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
    };
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const point = Number.parseInt(code.slice(2), 16);
      return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    if (code.startsWith("#")) {
      const point = Number.parseInt(code.slice(1), 10);
      return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    return named[code.toLowerCase()] ?? match;
  });

/** RSS content is untrusted text: strip markup and never execute or retain HTML. */
export const cleanRssText = (value: string): string =>
  normalize(
    decodeEntities(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(?:p|div|section|article|li|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );

const textValue = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const text = (value as Record<string, unknown>)["#text"];
    if (typeof text === "string" || typeof text === "number") return String(text);
  }
  return "";
};

const list = (value: unknown): unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

const publicUrl = (value: unknown): string | null => {
  const raw = textValue(value).trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const credentialKeys = ["username", "pass" + "word"] as const;
    if (!["http:", "https:"].includes(url.protocol) || raw.length > 2048 ||
        credentialKeys.some((key) => url[key as keyof URL] !== "")) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const parsePublishedAt = (value: unknown): string | undefined => {
  const raw = textValue(value).trim();
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
};

const maxDepth = (value: unknown, depth = 0): number => {
  if (!value || typeof value !== "object") return depth;
  let max = depth;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child && typeof child === "object") max = Math.max(max, maxDepth(child, depth + 1));
  }
  return max;
};

const externalIdFor = (guid: string, link: string | null): string => {
  const source = guid || link;
  if (!source) throw new NewsSourceError({ category: "PARSE_INVALID" });
  if (source.length <= 256) return source;
  return `sha256-${createHash("sha256").update(source).digest("hex")}`;
};

/** RSS2 parser. XML validation and entity/DTD rejection happen before tree access. */
export const parseRss2 = (xml: string): ParsedFeed => {
  const invalid = () => new NewsSourceError({ category: "PARSE_INVALID" });
  if (Buffer.byteLength(xml, "utf8") > MAX_FEED_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw invalid();
  }
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) throw invalid();
  let parsed: Record<string, unknown>;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@",
      textNodeName: "#text",
      processEntities: false,
      allowBooleanAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: false,
      ignoreDeclaration: true,
      ignorePiTags: true,
      maxNestedTags: MAX_DEPTH,
    }).parse(xml) as Record<string, unknown>;
  } catch {
    throw invalid();
  }
  if (maxDepth(parsed) > MAX_DEPTH) throw invalid();
  const rss = parsed.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  if (!channel) throw invalid();
  const feedTitle = cleanRssText(textValue(channel.title)).slice(0, 500);
  if (!feedTitle) throw invalid();
  const rawItems = list(channel.item);
  if (rawItems.length > MAX_ITEMS) throw invalid();
  const items: ParsedFeedItem[] = [];
  let skipped = 0;
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") {
      skipped++;
      continue;
    }
    const item = raw as Record<string, unknown>;
    const title = cleanRssText(textValue(item.title)).slice(0, 500);
    const link = publicUrl(item.link);
    const guid = textValue(item.guid).trim();
    if (!title || (!guid && !link)) {
      skipped++;
      continue;
    }
    const content = cleanRssText(textValue(item["content:encoded"]) || textValue(item.description)).slice(0, 20000);
    const publishedAt = parsePublishedAt(item.pubDate ?? item.published);
    items.push({
      externalId: externalIdFor(guid, link),
      title,
      url: link,
      content,
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  // 恰好一半仍可接纳；空源保持原有成功语义，不把单条坏数据升级为整源失败。
  if (skipped > rawItems.length / 2) throw invalid();
  return { title: feedTitle, items, skipped };
};

/** 仅识别 transport 的受控错误/Node 错误码，绝不转发外部错误原文。 */
const fetchFailure = (error: unknown): NewsSourceError => {
  const value = error instanceof Error ? error : undefined;
  const code = value && "code" in value ? value.code : undefined;
  if (value?.message === "Blocked private address" || value?.message === "Blocked local hostname") {
    return new NewsSourceError({ category: "SSRF_BLOCKED" });
  }
  if (value?.name === "AbortError" || value?.name === "TimeoutError" || code === "ETIMEDOUT" ||
      code === "ESOCKETTIMEDOUT" || code === "ABORT_ERR") {
    return new NewsSourceError({ category: "TIMEOUT" });
  }
  const http = /^HTTP ([1-5]\d{2})$/.exec(value?.message ?? "");
  if (http) return new NewsSourceError({ category: "HTTP_ERROR", httpStatus: Number(http[1]) });
  if (value?.message === "DNS unavailable" || ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET",
    "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "EAI_FAIL", "EPROTO"].includes(String(code))) {
    return new NewsSourceError({ category: "NETWORK" });
  }
  if (value?.message === "Response too large") return new NewsSourceError({ category: "PARSE_INVALID" });
  return new NewsSourceError({ category: "UNKNOWN" });
};

/** RSS 独立要求最终响应为 2xx；复用公共 transport，保留全部 DNS/SSRF/重定向防护。 */
export const fetchRss2 = async (
  url: string,
  config: Parameters<typeof safePublicGet>[1],
  signal: AbortSignal,
  get: typeof safePublicGet = safePublicGet,
): Promise<ParsedFeed> => {
  let page;
  try {
    page = await get(url, config, signal);
  } catch (error) {
    signal.throwIfAborted();
    throw fetchFailure(error);
  }
  if (page.status < 200 || page.status >= 300) {
    throw new NewsSourceError({ category: "HTTP_ERROR", httpStatus: page.status });
  }
  return parseRss2(page.body);
};
