import { useEffect, useState } from "react";
import { getTrace, listTraces, type TraceDetailDto, type TraceSummaryDto, type TracesQueryDto, type TracesResponseDto } from "../lib/api";

const kinds = ["chat", "information:notifications", "information:recommendations",   "dream", "subagent", "unlabeled"] as const satisfies readonly NonNullable<TracesQueryDto["kind"]>[];
const buttonClass = "rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm hover:bg-stone-50 disabled:opacity-40";
const inputClass = "rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm";
const objectOf = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const textOf = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "（未记录）";
const timeOf = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const statusOf = (trace: TraceSummaryDto) => [trace.meta.httpStatus ?? "无 HTTP 状态", trace.failure ? "失败" : null, trace.disconnected ? "断开" : null].filter((value) => value !== null).join(" · ");

/** 所有供应商载荷均按不可信纯文本展示，不解析 HTML，也不发送给任何模型。 */
const TextSection = ({ title, text, folded = false }: { title: string; text: string; folded?: boolean }) => (
  <details open={!folded} className="rounded-lg border border-stone-200 bg-white p-3">
    <summary className="cursor-pointer font-medium text-stone-800">{title} <span className="text-xs font-normal text-stone-500">{text.length.toLocaleString()} 字符 · 点击折叠/展开</span></summary>
    <pre tabIndex={0} aria-label={title} className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-stone-50 p-3 font-mono text-xs leading-relaxed text-stone-800">{text || "（空文本）"}</pre>
  </details>
);

const TraceDetail = ({ fileName, onBack }: { fileName: string; onBack: () => void }) => {
  const [detail, setDetail] = useState<TraceDetailDto | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null); setError("");
    void getTrace(fileName, controller.signal).then((data) => {
      if (!controller.signal.aborted) setDetail(data);
    }).catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "加载失败"); });
    return () => controller.abort();
  }, [fileName, retry]);
  const request = detail?.request;
  const response = detail?.response;
  // OpenAI 工具结果常只带 tool_call_id，从同一请求中先前的声明解析展示名称，不改原载荷。
  const toolNames = new Map<string, string>();
  for (const message of request?.messages ?? []) {
    const calls = objectOf(message).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const entry = objectOf(call);
      const name = objectOf(entry.function).name;
      if (typeof entry.id === "string" && typeof name === "string") toolNames.set(entry.id, name);
    }
  }
  return <div className="space-y-4">
    <button className={buttonClass} onClick={onBack}>返回列表</button>
    <h2 className="break-all text-lg font-semibold">{fileName}</h2>
    {error && <div role="alert" className="text-sm text-red-700">{error} <button className={buttonClass} onClick={() => setRetry((value) => value + 1)}>重试读取</button></div>}
    {!detail && !error && <p role="status" className="text-sm text-stone-500">正在读取完整记录…</p>}
    {detail && <>
      <section aria-label="调用元数据" className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm">
        <dl className="grid grid-cols-1 gap-2 break-all md:grid-cols-2">
          <div><dt className="text-stone-500">开始 / 结束</dt><dd>{detail.meta.startedAt} / {detail.meta.endedAt}</dd></div>
          <div><dt className="text-stone-500">Agent / kind</dt><dd>{detail.meta.sessionId} / {detail.meta.kind}</dd></div>
          <div><dt className="text-stone-500">耗时 / HTTP</dt><dd>{detail.meta.durationMs} ms / {detail.meta.httpStatus ?? "未记录"}</dd></div>
          <div><dt className="text-stone-500">上游 origin</dt><dd>{detail.meta.upstreamOrigin}</dd></div>
        </dl>
        {detail.meta.extra && <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-xs">{textOf(detail.meta.extra)}</pre>}
      </section>
      <TextSection title="System prompt" text={request?.system ?? "（未捕获请求）"} folded={(request?.system.length ?? 0) > 1800} />
      <section className="space-y-2" aria-label="请求消息">
        <h3 className="font-medium">Messages（{request?.messages.length ?? 0}）</h3>
        {!request?.messages.length && <p className="text-sm text-stone-500">未记录消息</p>}
        {request?.messages.map((message, index) => {
          const entry = objectOf(message);
          const role = typeof entry.role === "string" ? entry.role : "unknown";
          const toolName = entry.name ?? (typeof entry.tool_call_id === "string" ? toolNames.get(entry.tool_call_id) ?? entry.tool_call_id : undefined);
          return <TextSection key={index} title={`#${index + 1} · ${role}${toolName ? ` · ${String(toolName)}` : ""}`} text={textOf(entry.content ?? message) + (entry.tool_calls ? `\n\n工具调用\n${textOf(entry.tool_calls)}` : "")} folded={index > 1} />;
        })}
      </section>
      <section className="space-y-2" aria-label="工具声明">
        <h3 className="font-medium">Tools（{request?.tools.length ?? 0}）</h3>
        {!request?.tools.length && <p className="text-sm text-stone-500">未声明工具</p>}
        {request?.tools.map((tool, index) => {
          const entry = objectOf(tool);
          const fn = objectOf(entry.function ?? tool);
          return <details key={index} className="rounded-lg border border-stone-200 bg-white p-3">
            <summary className="cursor-pointer text-sm font-medium">{String(fn.name ?? `tool ${index + 1}`)}</summary>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm">{textOf(fn.description)}</p>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{textOf(tool)}</pre>
          </details>;
        })}
      </section>
      <TextSection title="Sampling / 请求诊断" text={textOf({ sampling: request?.sampling, parseError: request?.parseError })} folded />
      <section aria-label="响应" className="space-y-2">
        <h3 className="font-medium">Response</h3>
        <p className="break-all text-sm text-stone-600">finishReason: {response?.finishReason ?? "未记录"} · streamDone: {String(response?.streamDone ?? false)} · disconnected: {String(response?.disconnected ?? false)} · truncated: {String(response?.truncated ?? false)}</p>
        {response?.truncated && <p role="status" className="text-sm text-amber-800">已达到捕获上限，以下不是完整上游响应。</p>}
        {response?.failure && <TextSection title="Failure" text={response.failure} />}
        <TextSection title="输出全文" text={response?.outputText ?? "（未捕获响应）"} />
        {response?.toolCalls.map((call, index) => <TextSection key={index} title={`工具调用 · ${call.name}`} text={call.arguments} />)}
        {response?.errorBody !== undefined && <TextSection title="上游错误正文" text={response.errorBody} />}
        <TextSection title="Usage" text={textOf(response?.usage)} />
      </section>
      <TextSection title="完整原始 JSON（可选中复制）" text={textOf(detail)} folded />
    </>}
  </div>;
};

type Filters = { sessionId: string; kind: string; since: string; until: string };
const emptyFilters: Filters = { sessionId: "", kind: "", since: "", until: "" };

/** 桌面只读诊断页；分页游标保留在本组件，返回列表不丢筛选和页码。 */
export const TracesView = () => {
  const [draft, setDraft] = useState(emptyFilters);
  const [filters, setFilters] = useState(emptyFilters);
  const [cursors, setCursors] = useState<string[]>([]);
  const [page, setPage] = useState<TracesResponseDto | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const cursor = cursors.at(-1);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setPage(null);
    // datetime-local 的本地墙钟在发送前转成带 Z 的时间，避免服务端猜浏览器时区。
    void listTraces({
      ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
      ...(filters.kind ? { kind: filters.kind as TracesQueryDto["kind"] } : {}),
      ...(filters.since ? { since: new Date(filters.since).toISOString() } : {}),
      ...(filters.until ? { until: new Date(filters.until).toISOString() } : {}),
      ...(cursor ? { cursor } : {}), limit: 20,
    }, controller.signal).then((data) => {
      if (!controller.signal.aborted) setPage(data);
    }).catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "加载失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, cursor, refresh]);

  return <div className="h-full overflow-auto p-4 md:p-6">
    <div className="mx-auto max-w-6xl space-y-4">
      <div><h1 className="text-xl font-semibold text-stone-900">模型追踪</h1><p className="mt-1 text-sm text-stone-500">开发者诊断 · 只读记录 · 不进入模型上下文</p></div>
      {selected ? <TraceDetail key={selected} fileName={selected} onBack={() => setSelected(null)} /> : <>
        <form className="flex flex-wrap items-end gap-3 rounded-lg border border-stone-200 bg-stone-50 p-3" onSubmit={(event) => { event.preventDefault(); setFilters({ ...draft }); setCursors([]); setRefresh((value) => value + 1); }}>
          <label className="flex flex-col gap-1 text-xs text-stone-600">Agent（精确）<input className={inputClass} value={draft.sessionId} onChange={(event) => setDraft({ ...draft, sessionId: event.target.value })} /></label>
          <label className="flex flex-col gap-1 text-xs text-stone-600">Kind<select className={inputClass} value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}><option value="">全部</option>{kinds.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
          <label className="flex flex-col gap-1 text-xs text-stone-600">开始（本地时间）<input type="datetime-local" className={inputClass} value={draft.since} onChange={(event) => setDraft({ ...draft, since: event.target.value })} /></label>
          <label className="flex flex-col gap-1 text-xs text-stone-600">结束（包含边界）<input type="datetime-local" className={inputClass} value={draft.until} onChange={(event) => setDraft({ ...draft, until: event.target.value })} /></label>
          <button type="submit" className={buttonClass}>筛选 / 刷新</button>
          <button type="button" className={buttonClass} onClick={() => { setDraft(emptyFilters); setFilters(emptyFilters); setCursors([]); setRefresh((value) => value + 1); }}>重置</button>
        </form>
        {error && <p role="alert" className="text-sm text-red-700">{error} <button className={buttonClass} onClick={() => { setCursors([]); setRefresh((value) => value + 1); }}>从第一页重读</button></p>}
        {loading && <p role="status" className="text-sm text-stone-500">读取追踪摘要…</p>}
        {page && <>
          {page.badCount > 0 && <p role="status" className="text-sm text-amber-800">本次扫描跳过 {page.badCount} 个损坏或不可读条目。</p>}
          <div className="overflow-x-auto rounded-lg border border-stone-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-stone-50 text-xs text-stone-500"><tr>{["开始时间", "Agent", "Kind", "耗时", "状态", "输出字符", "截断"].map((heading) => <th key={heading} className="whitespace-nowrap p-3 font-medium">{heading}</th>)}</tr></thead>
              <tbody className="divide-y divide-stone-100">{page.traces.map((trace) => <tr key={trace.fileName} className="cursor-pointer hover:bg-stone-50" onClick={() => setSelected(trace.fileName)}>
                <td className="whitespace-nowrap p-3"><button className="text-blue-700 underline underline-offset-2" onClick={() => setSelected(trace.fileName)}>{timeOf(trace.meta.startedAt)}</button></td>
                <td className="break-all p-3">{trace.meta.sessionId}</td><td className="p-3">{trace.meta.kind}</td><td className="whitespace-nowrap p-3">{trace.meta.durationMs} ms</td>
                <td className="p-3">{statusOf(trace)}</td><td className="p-3 font-mono">{trace.outputChars.toLocaleString()}</td><td className="p-3">{trace.truncated ? "是" : "—"}</td>
              </tr>)}</tbody>
            </table>
            {page.traces.length === 0 && <p className="p-6 text-center text-sm text-stone-500">没有符合条件的记录；未启用记录或目录不存在时也会显示为空。</p>}
          </div>
          <div className="flex items-center gap-3"><button className={buttonClass} disabled={loading || cursors.length === 0} onClick={() => setCursors((values) => values.slice(0, -1))}>上一页</button><span className="text-sm text-stone-500">第 {cursors.length + 1} 页 · 本页 {page.traces.length} 条</span><button className={buttonClass} disabled={loading || !page.nextCursor} onClick={() => { if (page.nextCursor) setCursors((values) => [...values, page.nextCursor!]); }}>下一页</button></div>
        </>}
      </>}
    </div>
  </div>;
};
