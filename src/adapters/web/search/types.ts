import type { WebSearchResult } from "../../../features/web/types.js";
import type { SafePublicRequestFn, WebHttpClientConfig } from "../http-client.js";

export type WebSearchProviderId =
  | "duckduckgo"
  | "brave"
  | "tavily"
  | "searxng"
  | "jina";

export type WebSearchProvider = "auto" | WebSearchProviderId;

export type WebSearchConfig = {
  provider: WebSearchProvider;
  apiKey?: string;
  baseUrl?: string;
};

/** 搜索源执行上下文：只暴露安全请求入口与配置，不绑定底层 Node HTTP 细节。 */
export type SearchExecutionContext = {
  http: WebHttpClientConfig;
  search?: WebSearchConfig;
  request: SafePublicRequestFn;
};

/** 可插拔搜索源抽象：新增、替换或自定义搜索服务只需实现此接口并注册。 */
export type SearchSource = {
  readonly id: string;
  search: (
    query: string,
    count: number,
    context: SearchExecutionContext,
    signal?: AbortSignal,
  ) => Promise<WebSearchResult[]>;
};

export type SearchSourceRegistry = ReadonlyMap<string, SearchSource>;
