#!/usr/bin/env node
/**
 * 模型可用性巡检：探测 Magpie 网关，按供应商发最小真实请求，输出分类结果。
 * 用法：
 *   node scripts/model-audit.mjs            # 每供应商抽样 1 个代表模型（默认，省额度）
 *   node scripts/model-audit.mjs --full     # 目录内全部模型逐个实测
 *   node scripts/model-audit.mjs --json     # 机器可读输出（供技能落盘快照）
 * 判定原则：供应商配置 ready 不等于可用，只有真实请求成功才算 OK。
 * 凭据由 Magpie 自身持有，本脚本只与本地网关对话，不读取任何 key。
 */
import { setTimeout as delay } from "node:timers/promises";

const BASE = process.env.MAGPIE_BASE ?? "http://127.0.0.1:3425";
const args = new Set(process.argv.slice(2));
const FULL = args.has("--full");
const JSON_OUT = args.has("--json");
const TIMEOUT_MS = 60_000;

// 每个供应商的代表模型（抽样模式用）；--full 时忽略，改用目录全集。
const SAMPLES = {
  "minimax-cn": "minimax-cn/MiniMax-M2.5",
  qwenwork: "qwenwork/flash",
  "lee-gpt": "lee-gpt/cx/gpt-6.1-sol",
  zai: "zai/glm-4.5",
  siliconflow: "siliconflow/deepseek-ai/DeepSeek-V4.1-Flash",
  "kimi-code-cn": "kimi-code-cn/kimi-for-coding",
  "moonshot-cn": "moonshot-cn/kimi-k3",
};

function classifyError(message, code) {
  const m = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  if (m.includes("usage limit") || m.includes("rate limit") || m.includes("quota")) return "LIMIT";
  if (m.includes("authentication") || m.includes("api key") || m.includes("unauthorized") || m.includes("no active credentials") || m.includes("credential")) return "AUTH";
  if (m.includes("502") || m.includes("etimedout") || m.includes("timed out") || m.includes("reset after")) return "UPSTREAM";
  return "ERROR";
}

async function listModels() {
  try {
    const res = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return { error: `catalog http ${res.status}` };
    const data = await res.json();
    return { models: data.data ?? [] };
  } catch (e) {
    return { error: `网关不可达：${e.message}（确认 Magpie App 是否在运行）` };
  }
}

async function probe(id) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: id,
        messages: [{ role: "user", content: "reply with exactly: OK" }],
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    const ms = Date.now() - t0;
    if (body.error) {
      const e = body.error;
      return { id, status: classifyError(e.message, e.code ?? e.type), ms, note: (e.message ?? "").slice(0, 140) };
    }
    const content = body.choices?.[0]?.message?.content ?? "";
    if (!res.ok) return { id, status: "ERROR", ms, note: `http ${res.status}` };
    return { id, status: "OK", ms, note: content.trim().slice(0, 20) };
  } catch (e) {
    return { id, status: "UPSTREAM", ms: Date.now() - t0, note: e.message.slice(0, 140) };
  }
}

const catalog = await listModels();
if (catalog.error) {
  console.error(JSON_OUT ? JSON.stringify({ ok: false, error: catalog.error }) : `❌ ${catalog.error}`);
  process.exit(2);
}

const byProvider = new Map();
for (const m of catalog.models) {
  const p = (m.id.split("/")[0] || "?").replace(/\/.*$/, "");
  if (!byProvider.has(p)) byProvider.set(p, []);
  byProvider.get(p).push(m.id);
}

const targets = [];
for (const [p, ids] of byProvider) {
  if (FULL) targets.push(...ids.map((id) => ({ id, provider: p })));
  else targets.push({ id: SAMPLES[p] && ids.includes(SAMPLES[p]) ? SAMPLES[p] : ids[0], provider: p });
}

if (!JSON_OUT) {
  console.log(`Magpie ${BASE} · 目录 ${catalog.models.length} 个模型 · ${byProvider.size} 家供应商 · ${FULL ? "全量" : "抽样"}实测 ${targets.length} 个\n`);
}

const results = [];
for (const t of targets) {
  const r = await probe(t.id);
  results.push({ ...r, provider: t.provider });
  if (!JSON_OUT) {
    const icon = { OK: "✅", LIMIT: "⏳", AUTH: "🔑", UPSTREAM: "⚠️", ERROR: "❌" }[r.status];
    console.log(`${icon} ${r.id.padEnd(36)} ${r.status.padEnd(9)} ${r.ms}ms  ${r.note}`);
  }
  await delay(500); // 轻微间隔，避免瞬时并发触发限流
}

const summary = {};
for (const p of byProvider.keys()) {
  const rs = results.filter((r) => r.provider === p);
  summary[p] = { catalog: byProvider.get(p).length, ok: rs.filter((r) => r.status === "OK").length, statuses: [...new Set(rs.map((r) => r.status))] };
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: true, at: new Date().toISOString(), base: BASE, mode: FULL ? "full" : "sample", catalogTotal: catalog.models.length, summary, results }, null, 2));
} else {
  console.log("\n供应商汇总：");
  for (const [p, s] of Object.entries(summary)) console.log(`  ${p.padEnd(14)} 目录 ${String(s.catalog).padStart(3)} · 实测 ${s.ok} OK · ${s.statuses.join("/")}`);
  const allOk = Object.values(summary).every((s) => s.ok > 0);
  console.log(allOk ? "\n全部供应商至少一个模型可用。" : "\n存在不可用供应商，见上方分类（LIMIT=额度触顶会自动恢复，AUTH=需人工配凭据，UPSTREAM=上游故障）。");
}
