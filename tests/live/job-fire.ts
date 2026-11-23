import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { DatabaseSync } from 'node:sqlite';
import { createService } from '../../src/bootstrap/create-service.js';
import { createConfig } from '../../src/config/load-config.js';
import { createLiveModel, redactApiKey } from '../support/live-model.js';

const configPath = process.argv[2];
if (!configPath || !process.argv.includes('--allow-live')) {
  console.error('Usage: node --import tsx tests/live/job-fire.ts --config <path> --allow-live');
  process.exitCode = 1;
} else {
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as { model?: unknown };
  const model = createConfig({ server: { host: '127.0.0.1' }, model: raw.model });
  if (!model.configured || !model.baseUrl || !model.modelId) throw new Error('Model configuration is required');
  const root = await mkdtemp(join(tmpdir(), 'pi-muse-job-fire-'));
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  const proxy = await createLiveModel({ baseUrl: model.baseUrl, apiKey: model.apiKey });
  const report = { passed: false, failure: null as string | null, modelRequests: 0, checks: [] as string[], observedStatuses: [] as string[], upstreamStatuses: [] as (number | undefined)[] };
  try {
    const config = createConfig({
      server: { host: '127.0.0.1', accessKey: 'job-fire-access' },
      model: { baseUrl: proxy.baseUrl, id: model.modelId, apiKey: 'proxy-placeholder', contextWindow: model.contextWindow, maxTokens: model.maxTokens },
      runtime: { dataDir, runTimeoutMs: 180_000, schedulerIntervalMs: 1_000, monitorScanIntervalMs: 3_600_000 },
      tools: { presentation: { default: 'summary' }, web: { enabled: false }, browser: { enabled: false } },
    });
    const service = await createService(config, { sharedSkillsDir: join(dataDir, 'empty-shared-skills') });
    const http = serve({ fetch: service.app.fetch, hostname: '127.0.0.1', port: 0 });
    if (!http.listening) await once(http, 'listening');
    const address = http.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: 'job-fire-access' }) });
    assert.equal(login.status, 200);
    const { token } = await login.json() as { token: string };
    const get = async (path: string) => { const response = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } }); assert.equal(response.status, 200, path); return response.json(); };

    // 定时任务没有公开创建接口，只能由模型的 schedule 工具或服务层创建；这里用服务层避免重复模型轮。
    const job = await service.jobs.add('定时任务到点自检：回复 JOB_FIRED 即可', false, new Date(Date.now() + 8_000).toISOString());
    assert.ok(job.id && job.nextRunAt);
    report.checks.push('job created with a real due time');

    const deadline = Date.now() + 180_000;
    let fired: { id: string; status: string; lastRunAt?: string; nextRunAt?: string; lastResult?: string } | undefined;
    const seen = new Set<string>();
    while (Date.now() < deadline) {
      const jobs = (await get('/api/jobs')) as { jobs: Array<{ id: string; status: string; lastRunAt?: string; nextRunAt?: string; lastResult?: string }> };
      const found = jobs.jobs.find((item) => item.id === job.id);
      if (found) { seen.add(found.status); if (found.status === 'succeeded' || found.status === 'failed') { fired = found; break; } }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    report.observedStatuses = [...seen];
    assert.ok(fired, 'job never reached a terminal status');
    assert.equal(fired.status, 'succeeded', `job run must succeed; observed ${[...seen].join(',')}`);
    assert.ok(fired.lastRunAt, 'completed job must record lastRunAt');
    report.checks.push('scheduler fired the due job and recorded the result');
    assert.ok(proxy.traces.some((trace) => trace.users.some((text) => text.includes('定时任务'))), 'the model must actually receive the scheduled prompt');

    const history = await get('/api/conversation?sessionId=main');
    const messages = (history as { messages: Array<{ role: string; content?: string }> }).messages;
    assert.ok(messages.some((message) => message.role === 'assistant' && /JOB_FIRED/.test(message.content ?? '')), 'scheduled reply must reach the session');
    report.checks.push('scheduled model reply reached the session history');

    const database = new DatabaseSync(join(dataDir, 'state', 'main.sqlite'), { readOnly: true });
    try {
      const storedJob = database.prepare('SELECT last_status, last_run_at, enabled FROM jobs WHERE id = ?').get(job.id) as { last_status: string; last_run_at: string; enabled: number } | undefined;
      // 存储字段是领域事实 last_status；API 才把它映射成 succeeded/failed。
      assert.equal(storedJob?.last_status, 'completed');
      assert.ok(storedJob?.last_run_at);
      assert.equal(storedJob?.enabled, 0, 'a finished one-time job must not stay scheduled');
    } finally { database.close(); }
    report.checks.push('job result persisted in main.sqlite');

    await service.close();
    if ("closeAllConnections" in http) http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    const restarted = await createService(config, { sharedSkillsDir: join(dataDir, 'empty-shared-skills') });
    const http2 = serve({ fetch: restarted.app.fetch, hostname: '127.0.0.1', port: 0 });
    if (!http2.listening) await once(http2, 'listening');
    try {
      const address2 = http2.address();
      assert.ok(address2 && typeof address2 !== 'string');
      const base2 = `http://127.0.0.1:${address2.port}`;
      const login2 = await fetch(base2 + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: 'job-fire-access' }) });
      const { token: token2 } = await login2.json() as { token: string };
      const jobs2 = await (await fetch(base2 + '/api/jobs', { headers: { authorization: `Bearer ${token2}` } })).json() as { jobs: Array<{ id: string; status: string }> };
      assert.equal(jobs2.jobs.find((item) => item.id === job.id)?.status, 'succeeded');
      const requestsBefore = proxy.traces.length;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      assert.equal(proxy.traces.length, requestsBefore, 'restart must not replay a completed job');
      report.checks.push('completed job survives restart without replay');
      report.passed = true;
    } finally {
      await restarted.close();
      if ("closeAllConnections" in http2) http2.closeAllConnections();
      await new Promise<void>((resolve) => http2.close(() => resolve()));
    }
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    report.modelRequests = proxy.traces.length;
    report.upstreamStatuses = proxy.traces.map((t) => t.upstreamStatus);
    await writeFile(join(root, 'job-fire-summary.json'), redactApiKey(JSON.stringify(report, null, 2), model.apiKey) + '\n', { mode: 0o600 });
    await proxy.close();
    console.log(JSON.stringify({ ...report, artifactRoot: root }));
  }
}
