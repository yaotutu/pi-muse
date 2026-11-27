import type { WebSearchResult } from "../../../features/web/types.js";
import type { SafePublicRequestFn, WebHttpClientConfig } from "../http-client.js";
import { braveSearchSource } from "./providers/brave.js";
import { duckDuckGoSearchSource } from "./providers/duckduckgo.js";
import { jinaSearchSource } from "./providers/jina.js";
import { searxngSearchSource } from "./providers/searxng.js";
import { tavilySearchSource } from "./providers/tavily.js";
import type {
  SearchSource,
  SearchSourceRegistry,
  WebSearchConfig,
  WebSearchProviderId,
} from "./types.js";

const BUILTIN_SEARCH_SOURCES: readonly SearchSource[] = [
  tavilySearchSource,
  braveSearchSource,
  searxngSearchSource,
  jinaSearchSource,
  duckDuckGoSearchSource,
];

/** 构建搜索源注册表；允许通过 customSources 覆盖内置实现或注册新搜索源。 */
export const createSearchSourceRegistry = (
  customSources?: Iterable<SearchSource>,
): Map<string, SearchSource> => {
  const registry = new Map<string, SearchSource>();
  for (const source of BUILTIN_SEARCH_SOURCES) {
    registry.set(source.id, source);
  }
  if (customSources) {
    for (const source of customSources) {
      registry.set(source.id, source);
    }
  }
  return registry;
};

/** 根据显式配置、自建地址或密钥前缀解析实际生效的搜索源标识。 */
export const resolveSearchProvider = (
  search?: WebSearchConfig,
): WebSearchProviderId => {
  const provider = search?.provider ?? "auto";
  if (provider !== "auto") return provider;
  if (search?.baseUrl) return "searxng";
  const apiKey = search?.apiKey;
  if (apiKey) {
    if (apiKey.startsWith("tvly-")) return "tavily";
    if (apiKey.startsWith("jina_")) return "jina";
    return "brave";
  }
  return "duckduckgo";
};

/** 创建统一的搜索调度器；按配置从注册表选择搜索源并注入统一执行上下文。 */
export const createWebSearchEngine = (options: {
  http: WebHttpClientConfig;
  search?: WebSearchConfig;
  request: SafePublicRequestFn;
  registry?: SearchSourceRegistry;
}): {
  providerId: WebSearchProviderId;
  search: (query: string, count: number, signal?: AbortSignal) => Promise<WebSearchResult[]>;
} => {
  const registry = options.registry ?? createSearchSourceRegistry();
  const providerId = resolveSearchProvider(options.search);
  return {
    providerId,
    search: async (query, count, signal) => {
      signal?.throwIfAborted();
      const source = registry.get(providerId);
      if (!source) {
        throw new Error(`Unknown web search provider: ${providerId}`);
      }
      return source.search(
        query,
        count,
        { http: options.http, search: options.search, request: options.request },
        signal,
      );
    },
  };
};
