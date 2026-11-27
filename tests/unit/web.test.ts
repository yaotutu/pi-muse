import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createWebService, UNTRUSTED_CONTENT_BANNER } from "../../src/features/web/web-service.js";
import {
  createHttpWebTransport,
  createSearchSourceRegistry,
  parseBingRssResults,
  parseBraveResults,
  parseDuckDuckGoResults,
  parseJinaSearchResults,
  parseSearxngResults,
  parseTavilyResults,
  resolveSearchProvider,
  safePublicGet,
  shouldBypassExternalReader,
  type HttpRequestFn,
  type SearchSource,
} from "../../src/adapters/web/http-transport.js";
import { resolvePublicHost } from "../../src/shared/public-host.js";
import type { FetchedWebPage, WebSearchResult, WebTransport } from "../../src/features/web/types.js";

const service = (transport: Partial<WebTransport>) =>
  createWebService(
    {
      search: async () => [],
      fetch: async () => ({}) as FetchedWebPage,
      ...transport,
    } as WebTransport,
    { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 },
  );

test("web service projects structured search results", async () => {
  const web = service({
    search: async (query, count) => {
      assert.equal(query, "personal bot");
      assert.equal(count, 2);
      return [
        { title: "Example", url: "https://example.test/a", snippet: "<b>Snippet</b>" },
      ];
    },
  });
  const value = await web.search("  personal bot  ", 2);
  assert.deepEqual(value, {
    results: [
      { title: "Example", url: "https://example.test/a", snippet: "Snippet" },
    ],
    warnings: [],
    truncated: false,
  });
});

test("web service sanitizes transport failures and validates input", async () => {
  const failing = service({
    search: async () => { throw new Error("secret search endpoint"); },
    fetch: async () => { throw new Error("secret fetch endpoint"); },
  });
  assert.deepEqual(await failing.search("query"), {
    error: "Web search failed",
  });
  assert.deepEqual(await failing.fetch("https://example.test"), {
    error: "Web fetch failed",
    url: "https://example.test/",
  });
  assert.deepEqual(await failing.fetch("file:///etc/passwd"), {
    error: "URL validation failed: only public HTTP(S) URLs are allowed",
    url: "file:///etc/passwd",
  });
});

test("web fetch extracts, truncates and marks untrusted HTML", async () => {
  const web = service({
    fetch: async () => ({
      finalUrl: "https://example.test/final",
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<title>Title</title><script>ignore()</script><h1>Head</h1><p>Body &amp; more</p>",
    }),
  });
  const result = await web.fetch("https://example.test");
  assert.ok(!("error" in result));
  assert.equal(result.finalUrl, "https://example.test/final");
  assert.equal(result.extractor, "markdown");
  assert.equal(result.truncated, false);
  assert.match(result.text, new RegExp(UNTRUSTED_CONTENT_BANNER));
  assert.match(result.text, /# Title/);
  assert.match(result.text, /# Head/);
  assert.match(result.text, /Body & more/);
});

test("DuckDuckGo parser decodes redirect targets, titles and snippets", () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fa&amp;rut=abc">Example &amp; Company</a>
    <a class="result__snippet" href="#">Snippet &lt;b&gt;text&lt;/b&gt;</a>
    <a class="result__a" href="https://example.test/b">Second</a>
    <a class="result__snippet" href="#">Second snippet</a>`;
  assert.deepEqual(parseDuckDuckGoResults(html, 2), [
    {
      title: "Example & Company",
      url: "https://example.test/a",
      snippet: "Snippet <b>text</b>",
    },
    { title: "Second", url: "https://example.test/b", snippet: "Second snippet" },
  ]);
});

test("Bing RSS parser extracts fallback search results", () => {
  const xml = `<rss><channel><item><title>A &amp; B</title><link>https://example.test/a</link><description>Snippet</description></item><item><title>Drop</title><link>ftp://example.test</link></item></channel></rss>`;
  assert.deepEqual(parseBingRssResults(xml, 2), [
    { title: "A & B", url: "https://example.test/a", snippet: "Snippet" },
  ]);
});

test("public HTTP transport blocks local and private DNS targets before connecting", async () => {
  for (const host of ["localhost", "127.0.0.1", "::1", "10.0.0.1", "172.16.0.1", "192.168.1.2"]) {
    await assert.rejects(() => resolvePublicHost(host), /Blocked|DNS unavailable/);
  }
});

test("public HTTP transport handles WHATWG IPv6 bracketed hostnames and allowPrivateTargets", async () => {
  // 1. 默认拒绝 IPv6 回环与私网字面量（带方括号与不带方括号）
  await assert.rejects(() => resolvePublicHost("[::1]", false), /Blocked|DNS unavailable/);
  await assert.rejects(() => resolvePublicHost("::1", false), /Blocked|DNS unavailable/);
  await assert.rejects(() => resolvePublicHost("[fe80::1]", false), /Blocked|DNS unavailable/);

  // 2. allowPrivateTargets=true 时允许 ::1 与私网 IPv6
  const loopbackBracketed = await resolvePublicHost("[::1]", true);
  assert.deepEqual(loopbackBracketed, { address: "::1", family: 6 });
  const loopbackPlain = await resolvePublicHost("::1", true);
  assert.deepEqual(loopbackPlain, { address: "::1", family: 6 });

  // 3. 公网 IPv6 字面量直接解析并按 IP 校验通过（带方括号与不带方括号）
  const publicV6Bracketed = await resolvePublicHost("[2606:4700:4700::1111]", false);
  assert.deepEqual(publicV6Bracketed, { address: "2606:4700:4700::1111", family: 6 });
  const publicV6Plain = await resolvePublicHost("2606:4700:4700::1111", false);
  assert.deepEqual(publicV6Plain, { address: "2606:4700:4700::1111", family: 6 });
});

test("safePublicGet timeoutMs is the total budget for the whole fetch across redirects", async () => {
  const hopsTimeouts: number[] = [];
  const mockDoRequest = async (url: URL, _config: unknown, _pinned: unknown, timeoutMs: number, signal?: AbortSignal) => {
    hopsTimeouts.push(timeoutMs);
    signal?.throwIfAborted();
    if (url.pathname === "/first") {
      // 模拟第一跳耗时 60ms 后返回 302 重定向到 /second
      await new Promise((resolve) => setTimeout(resolve, 60));
      signal?.throwIfAborted();
      return {
        status: 302,
        headers: { location: "http://[2606:4700:4700::1111]/second" },
        body: "",
        url,
      };
    }
    return {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "final-content",
      url,
    };
  };

  const res = await safePublicGet(
    "http://[2606:4700:4700::1111]/first",
    { timeoutMs: 500, maxResponseBytes: 1024, allowPrivateTargets: false },
    undefined,
    mockDoRequest,
  );
  assert.equal(res.body, "final-content");
  assert.equal(hopsTimeouts.length, 2);
  // 第一跳获得的预算接近 500ms
  assert.ok(hopsTimeouts[0]! >= 400 && hopsTimeouts[0]! <= 500);
  // 第二跳获得的预算必须扣除第一跳耗时
  assert.ok(hopsTimeouts[1]! < hopsTimeouts[0]!);
  assert.ok(hopsTimeouts[1]! <= 450);

  // 累积耗时超出总预算时触发整体超时拒绝
  const hangingDoRequest = async (url: URL, _config: unknown, _pinned: unknown, _timeoutMs: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (url.pathname === "/start") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      signal?.throwIfAborted();
      return {
        status: 302,
        headers: { location: "http://[2606:4700:4700::1111]/hang" },
        body: "",
        url,
      };
    }
    // 第二跳阻塞等待超过剩余预算
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 200);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
    return { status: 200, headers: {}, body: "", url };
  };

  await assert.rejects(
    safePublicGet(
      "http://[2606:4700:4700::1111]/start",
      { timeoutMs: 80, maxResponseBytes: 1024, allowPrivateTargets: false },
      undefined,
    hangingDoRequest,
    ),
    /abort/i,
  );
});

// ---- AbortSignal 透传与取消语义 ----
// 取消与普通失败路径不同：取消直接 reject signal.reason，transport 不被调用或在途被监听；
// 仅 transport 自身异常（非取消）仍按受控失败脱敏。

/** 可控 promise：resolve/reject 由测试驱动，不依赖 sleep。 */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** 用真实 AbortController 监听 signal，在 abort 时把 transport 的 promise reject 为 signal.reason。 */
const signalAwareTransport = (
  transport: Partial<WebTransport>,
): { transport: WebTransport; pending: { search: { signal: AbortSignal; reason?: unknown } | null; fetch: { signal: AbortSignal; reason?: unknown } | null } } => {
  const pending = {
    search: null as { signal: AbortSignal; reason?: unknown } | null,
    fetch: null as { signal: AbortSignal; reason?: unknown } | null,
  };
  const searchImpl = async (query: string, count: number, signal?: AbortSignal) => {
    if (!signal) {
      // 没有 signal 时直接走兜底 transport，不模拟取消监听
      return transport.search ? transport.search(query, count) : [];
    }
    if (signal.aborted) throw signal.reason;
    const d = deferred<WebSearchResult[]>();
    pending.search = { signal };
    const onAbort = () => {
      const current = pending.search;
      if (current && current.signal === signal) {
        current.reason = signal.reason;
        d.reject(signal.reason);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (transport.search) {
      transport.search(query, count).then(d.resolve, d.reject);
    }
    return d.promise;
  };
  const fetchImpl = async (url: string, signal?: AbortSignal) => {
    if (!signal) {
      return transport.fetch
        ? transport.fetch(url)
        : ({ finalUrl: url, status: 200, contentType: "text/html", body: "" });
    }
    if (signal.aborted) throw signal.reason;
    const d = deferred<FetchedWebPage>();
    pending.fetch = { signal };
    const onAbort = () => {
      const current = pending.fetch;
      if (current && current.signal === signal) {
        current.reason = signal.reason;
        d.reject(signal.reason);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (transport.fetch) {
      transport.fetch(url).then(d.resolve, d.reject);
    }
    return d.promise;
  };
  return {
    pending,
    transport: {
      search: searchImpl,
      fetch: fetchImpl,
    },
  };
};

test("search rejects pre-aborted signal without invoking transport", async () => {
  const transport = {
    search: async () => assert.fail("transport.search must not run"),
    fetch: async () => ({}) as FetchedWebPage,
  };
  const web = createWebService(
    transport as WebTransport,
    { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 },
  );
  const reason = new Error("pre-cancel-search");
  const controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(
    () => web.search("query", 2, controller.signal),
    (error: unknown) => error === reason,
  );
});

test("fetch rejects pre-aborted signal without invoking transport", async () => {
  const transport = {
    search: async () => [],
    fetch: async () => assert.fail("transport.fetch must not run"),
  };
  const web = createWebService(
    transport as WebTransport,
    { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 },
  );
  const reason = new Error("pre-cancel-fetch");
  const controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(
    () => web.fetch("https://example.test", "markdown", 200, controller.signal),
    (error: unknown) => error === reason,
  );
});

test("in-flight abort on search rejects with signal.reason, not generic WebFailure", async () => {
  const { transport, pending } = signalAwareTransport({});
  const web = createWebService(transport, { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 });
  const controller = new AbortController();
  const reason = new Error("aborted-mid-search");
  const promise = web.search("query", 3, controller.signal);
  // 确保 transport.search 已被调用且挂起
  await Promise.resolve();
  assert.ok(pending.search, "transport.search should have started");
  controller.abort(reason);
  await assert.rejects(promise, (error: unknown) => error === reason);
});

test("in-flight abort on fetch rejects with signal.reason, not generic WebFailure", async () => {
  const { transport, pending } = signalAwareTransport({});
  const web = createWebService(transport, { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 });
  const controller = new AbortController();
  const reason = new Error("aborted-mid-fetch");
  const promise = web.fetch("https://example.test", "markdown", 1000, controller.signal);
  await Promise.resolve();
  assert.ok(pending.fetch, "transport.fetch should have started");
  controller.abort(reason);
  await assert.rejects(promise, (error: unknown) => error === reason);
});

test("abort immediately before returning a successful transport does not turn the result into success", async () => {
  // transport 模拟"在 await 期间 abort 已经发生并完成"的窗口：transport 收到 abort 后
  // 仍然按成功路径返回（resolve with [] / 页面对象），service 必须在 await 之后再次
  // throwIfAborted，确保取消仍 wins 而不会返回伪成功对象。
  const searchController = new AbortController();
  const searchReason = new Error("aborted-before-return-search");
  let searchAbortSeen = false;
  const searchTransport: WebTransport = {
    search: async (_q, _c, signal) =>
      new Promise<WebSearchResult[]>((resolve) => {
        signal?.addEventListener("abort", () => {
          searchAbortSeen = true;
          // 模拟 transport 自身完成了 fetch 但 signal 已被 abort；
          // resolve 一个会令 service 误判成功的数据。
          resolve([]);
        }, { once: true });
      }),
    fetch: async () => ({ finalUrl: "", status: 0, contentType: "", body: "" }),
  };
  const searchWeb = createWebService(searchTransport, { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 });
  const searchPromise = searchWeb.search("query", 2, searchController.signal);
  searchController.abort(searchReason);
  const searchOutcome: { kind: "resolved"; value: unknown } | { kind: "rejected"; error: unknown } =
    await searchPromise.then(
      (value) => ({ kind: "resolved", value }),
      (error: unknown) => ({ kind: "rejected", error }),
    );
  assert.equal(searchAbortSeen, true, "abort listener should have fired");
  assert.equal(searchOutcome.kind, "rejected", "search must reject, not resolve");
  assert.equal((searchOutcome as { kind: "rejected"; error: unknown }).error, searchReason,
    "search must reject with abort reason");

  const fetchController = new AbortController();
  const fetchReason = new Error("aborted-before-return-fetch");
  let fetchAbortSeen = false;
  const fetchTransport: WebTransport = {
    search: async () => [],
    fetch: async (url, signal) =>
      new Promise<FetchedWebPage>((resolve) => {
        signal?.addEventListener("abort", () => {
          fetchAbortSeen = true;
          resolve({
            finalUrl: url,
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: "<title>x</title><p>body</p>",
          });
        }, { once: true });
      }),
  };
  const fetchWeb = createWebService(fetchTransport, { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 });
  const fetchPromise = fetchWeb.fetch("https://example.test", "markdown", 1000, fetchController.signal);
  fetchController.abort(fetchReason);
  const fetchOutcome: { kind: "resolved"; value: unknown } | { kind: "rejected"; error: unknown } =
    await fetchPromise.then(
      (value) => ({ kind: "resolved", value }),
      (error: unknown) => ({ kind: "rejected", error }),
    );
  assert.equal(fetchAbortSeen, true, "fetch abort listener should have fired");
  assert.equal(fetchOutcome.kind, "rejected", "fetch must reject, not resolve");
  assert.equal((fetchOutcome as { kind: "rejected"; error: unknown }).error, fetchReason,
    "fetch must reject with abort reason");
});

test("non-cancellation transport failures still surface as generic WebFailure", async () => {
  // 现有脱敏语义：transport 抛非 abort 错误时，service 返回受控 failure 对象，
  // 不向上抛出原始错误，也不暴露 transport 内部细节。
  const transport = {
    search: async () => { throw new Error("secret search reason"); },
    fetch: async () => { throw new Error("secret fetch reason"); },
  } as WebTransport;
  const web = createWebService(transport, { searchResults: 5, maxSearchResults: 10, maxContentChars: 1000 });
  // 没有 signal / 未 abort 时仍走原通用失败路径
  assert.deepEqual(await web.search("query"), { error: "Web search failed" });
  assert.deepEqual(await web.fetch("https://example.test"), {
    error: "Web fetch failed",
    url: "https://example.test/",
  });
});

test("search provider inference and JSON result parsers support Tavily, Brave, SearXNG and Jina", () => {
  assert.equal(resolveSearchProvider(), "duckduckgo");
  assert.equal(resolveSearchProvider({ provider: "auto", baseUrl: "http://127.0.0.1:8080" }), "searxng");
  assert.equal(resolveSearchProvider({ provider: "auto", apiKey: "tvly-123" }), "tavily");
  assert.equal(resolveSearchProvider({ provider: "auto", apiKey: "jina_123" }), "jina");
  assert.equal(resolveSearchProvider({ provider: "auto", apiKey: "BSA-123" }), "brave");
  assert.equal(resolveSearchProvider({ provider: "brave", apiKey: "tvly-123" }), "brave");

  assert.deepEqual(
    parseTavilyResults({
      results: [
        { title: " T1 ", url: "https://a.example", content: " S1 " },
        { title: "Bad", url: "javascript:alert(1)", content: "x" },
      ],
    }, 5),
    [{ title: "T1", url: "https://a.example", snippet: "S1" }],
  );
  assert.deepEqual(
    parseBraveResults({
      web: { results: [{ title: "B1", url: "https://b.example", description: "Desc" }] },
    }, 5),
    [{ title: "B1", url: "https://b.example", snippet: "Desc" }],
  );
  assert.deepEqual(
    parseSearxngResults({
      results: [{ title: "X1", url: "http://c.example", content: "Snippet" }],
    }, 5),
    [{ title: "X1", url: "http://c.example", snippet: "Snippet" }],
  );
  assert.deepEqual(
    parseJinaSearchResults({
      data: [{ title: "J1", url: "https://d.example", description: "JDesc" }],
    }, 5),
    [{ title: "J1", url: "https://d.example", snippet: "JDesc" }],
  );
});

test("shouldBypassExternalReader protects credentials, auth params, raw data and local targets", () => {
  assert.equal(shouldBypassExternalReader(new URL("https://example.com/article")), false);
  assert.equal(shouldBypassExternalReader(new URL("https://example.com/article"), { useJinaReader: false }), true);
  assert.equal(shouldBypassExternalReader(new URL("https://example.com/article"), { allowPrivateTargets: true }), true);
  assert.equal(shouldBypassExternalReader(new URL("https://user:pass@example.com/article")), true);
  assert.equal(shouldBypassExternalReader(new URL("https://example.com/doc?token=secret")), true);
  assert.equal(shouldBypassExternalReader(new URL("https://example.com/doc?X-Amz-Signature=abc")), true);
  assert.equal(shouldBypassExternalReader(new URL("https://example.com/feed.json")), true);
  assert.equal(shouldBypassExternalReader(new URL("https://example.com/feed.xml")), true);
  assert.equal(shouldBypassExternalReader(new URL("https://example.com/readme.txt")), true);
});

test("Jina Reader extracts Markdown on success and falls back cleanly on failure or bypass", async () => {
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
  const fakeDns = { address: "93.184.216.34", family: 4 as const };
  const fakeTransport: HttpRequestFn = async (url, _cfg, _pinned, _timeout, _sig, opts) => {
    calls.push({ url: url.toString(), method: opts?.method, headers: opts?.headers, body: opts?.body });
    if (url.hostname === "r.jina.ai") {
      if (url.toString().includes("fallback.example")) {
        return { status: 503, headers: {}, body: "unavailable", url };
      }
      return {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
        body: "# Clean Markdown\n\nBody text.",
        url,
      };
    }
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<html><title>Direct</title><body><p>Local HTML</p></body></html>",
      url,
    };
  };

  // 使用纯 IPv4 字面量触发 resolvePublicHost 公网放行而无需真实外网 DNS 解析
  const jinaTransport = createHttpWebTransport({
    timeoutMs: 5000,
    maxResponseBytes: 100000,
    fetch: { useJinaReader: true, jinaApiKey: "jina_demo" },
  }, fakeTransport);
  const web = createWebService(jinaTransport, { searchResults: 5, maxSearchResults: 10, maxContentChars: 5000 });
  const ok = await web.fetch("https://93.184.216.34/post");
  assert.equal("error" in ok, false);
  if (!("error" in ok)) {
    assert.equal(ok.extractor, "jina");
    assert.match(ok.text, /# Clean Markdown/);
  }
  assert.equal(calls[0]?.url, "https://r.jina.ai/https://93.184.216.34/post");
  assert.equal(calls[0]?.headers?.authorization, "Bearer jina_demo");

  // 含敏感参数 URL 绕过 Jina Reader，直接本地抓取（防止凭据泄漏）
  calls.length = 0;
  const direct = await web.fetch("https://93.184.216.34/doc?access_token=topsecret");
  assert.equal("error" in direct, false);
  if (!("error" in direct)) assert.equal(direct.extractor, "markdown");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://93.184.216.34/doc?access_token=topsecret");

  // 私网 IP 在提交到 r.jina.ai 之前即被 SSRF 拦截
  calls.length = 0;
  const blocked = await web.fetch("http://127.0.0.1/admin");
  assert.deepEqual(blocked, { error: "Web fetch failed", url: "http://127.0.0.1/admin" });
  assert.equal(calls.length, 0);

  // Jina 异常时无缝回退本地抽取；fakeDns 仅作静态引用确认
  assert.equal(fakeDns.family, 4);
  const fallbackWeb = createWebService(
    createHttpWebTransport({ timeoutMs: 5000, maxResponseBytes: 100000 }, async (url) => {
      if (url.hostname === "r.jina.ai") throw new Error("upstream down");
      return { status: 200, headers: { "content-type": "text/html" }, body: "<p>Local fallback</p>", url };
    }),
    { searchResults: 5, maxSearchResults: 10, maxContentChars: 5000 },
  );
  const fb = await fallbackWeb.fetch("https://93.184.216.34/fallback.example");
  assert.equal("error" in fb, false);
  if (!("error" in fb)) {
    assert.equal(fb.extractor, "markdown");
    assert.match(fb.text, /Local fallback/);
  }
});

test("HTTP proxy config forwards requests with Proxy-Authorization while preserving SSRF rules", async (t) => {
  let seenUrl = "";
  let seenAuth = "";
  const proxy = createServer((req, res) => {
    seenUrl = req.url ?? "";
    seenAuth = typeof req.headers["proxy-authorization"] === "string" ? req.headers["proxy-authorization"] : "";
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("proxied body");
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", () => done()));
  t.after(() => proxy.close());
  const port = (proxy.address() as AddressInfo).port;

  const page = await safePublicGet("http://127.0.0.1:9999/hello", {
    timeoutMs: 5000,
    maxResponseBytes: 10000,
    allowPrivateTargets: true,
    proxy: `http://alice:s3cr3t@127.0.0.1:${port}`,
  });
  assert.equal(page.status, 200);
  assert.equal(page.body, "proxied body");
  assert.equal(seenUrl, "http://127.0.0.1:9999/hello");
  assert.equal(seenAuth, `Basic ${Buffer.from("alice:s3cr3t").toString("base64")}`);

  // 未放开私网目标时，即使配了代理也会提前被 SSRF 拦截，绝不打到代理
  seenUrl = "";
  await assert.rejects(
    safePublicGet("http://127.0.0.1:9999/hello", {
      timeoutMs: 5000,
      maxResponseBytes: 10000,
      proxy: `http://127.0.0.1:${port}`,
    }),
  );
  assert.equal(seenUrl, "");
});

test("search source registry allows overriding built-in provider with a custom SearchSource", async () => {
  const received: Array<{ query: string; count: number; provider: string | undefined }> = [];
  const customDuckDuckGo: SearchSource = {
    id: "duckduckgo",
    search: async (query, count, context) => {
      received.push({ query, count, provider: context.search?.provider });
      return [
        {
          title: "<b>Custom Source</b>",
          url: "https://custom.example/result",
          snippet: "Custom snippet &amp; summary",
        },
      ];
    },
  };
  const registry = createSearchSourceRegistry([customDuckDuckGo]);
  assert.ok(registry.has("tavily"));
  assert.equal(registry.get("duckduckgo"), customDuckDuckGo);

  const transport = createHttpWebTransport(
    {
      timeoutMs: 5000,
      maxResponseBytes: 10000,
      search: { provider: "auto" },
    },
    undefined,
    registry,
  );
  const web = createWebService(transport, { searchResults: 5, maxSearchResults: 10, maxContentChars: 5000 });
  const result = await web.search("pluggable search", 3);
  assert.deepEqual(received, [{ query: "pluggable search", count: 3, provider: "auto" }]);
  assert.deepEqual(result, {
    results: [
      {
        title: "Custom Source",
        url: "https://custom.example/result",
        snippet: "Custom snippet & summary",
      },
    ],
    warnings: [],
    truncated: false,
  });
});
