import { useEffect, useState } from "react";
import { listNews, refreshNews, type NewsArticleDto } from "../lib/api";

/** 联调台展示服务端权威文章；外部正文只用文本节点，不执行 HTML。 */
export const NewsView = () => {
  const [articles, setArticles] = useState<NewsArticleDto[]>([]);
  const [selected, setSelected] = useState<NewsArticleDto | null>(null);
  const [view, setView] = useState<"all" | "recommended">("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void listNews(view, undefined, controller.signal).then((page) => { setArticles(page.articles); setCursor(page.nextCursor); setSelected(null); }, (e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [view]);
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      await refreshNews();
      const page = await listNews(view);
      setArticles(page.articles);
      setCursor(page.nextCursor);
    } catch (e) { setError(e instanceof Error ? e.message : "读取失败"); }
    finally { setBusy(false); }
  };
  return <section className="h-full overflow-auto p-6 space-y-4">
    <h1>新闻</h1>
    <div className="flex gap-3"><button onClick={() => setView("all")}>全部</button><button onClick={() => setView("recommended")}>推荐</button><button disabled={busy} onClick={() => void refresh()}>{busy ? "抓取中" : "刷新来源"}</button></div>
    {error && <p role="alert">{error}</p>}
    {selected ? <article className="space-y-3"><button onClick={() => setSelected(null)}>返回文章列表</button><h2>{selected.title}</h2><p className="whitespace-pre-wrap">{selected.content}</p>{selected.url && <a href={selected.url} target="_blank" rel="noreferrer">原文</a>}</article> : <>
      {articles.map((article) => <button key={article.id} className="block w-full rounded border bg-white p-3 text-left" onClick={() => setSelected(article)}><strong>{article.title}</strong><p>{article.sourceTitle} · {article.publishedAt}</p>{article.recommendation && <p>{article.recommendation.reason}</p>}</button>)}
      {!articles.length && <p>暂无文章，请先通过 /docs 配置 RSS 来源。</p>}
      {cursor && <button onClick={() => void listNews(view, cursor).then((page) => { setArticles((current) => [...current, ...page.articles]); setCursor(page.nextCursor); }, (e: Error) => setError(e.message))}>下一页</button>}
    </>}
  </section>;
};
