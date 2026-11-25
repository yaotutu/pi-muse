import { createAndroidReleaseMirror } from "../adapters/releases/android-release-mirror.js";
import { createCompanionService } from "../features/companions/service.js";
import { createCompanionStore } from "../adapters/storage/companions-store.js";
import { createSessionRepository, createSessionStorage, initializeMainSession } from "../adapters/storage/session-repository.js";
import { createSessionService } from "../features/sessions/service.js";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { createAuth } from "../adapters/auth/token-service.js";
import type { Config } from "../config/load-config.js";
import { createConversation } from "../features/conversation/conversation-service.js";
import { createSessionHub } from "../features/conversation/conversation-hub.js";
import { createJobService } from "../features/jobs/job-service.js";
import { createGoalService } from "../features/goals/goal-service.js";
import { createActionService } from "../features/actions/action-service.js";
import { createMonitorService } from "../features/monitors/monitor-service.js";
import { createMonitorScheduler } from "../features/monitors/monitor-scheduler.js";
import { createSkillsService } from "../features/skills/service.js";
import { createMemoryService } from "../features/memory/memory-service.js";
import { createIdentityService } from "../features/identity/identity-service.js";
import { readProfileFile, writeProfileFile } from "../adapters/storage/profile-files.js";
import { inspectProfileFile, readResolvedProfileFile } from "../adapters/storage/workspace-document-includes.js";
import { createJobRepository } from "../adapters/storage/job-repository.js";
import { createGoalRepository } from "../adapters/storage/goal-repository.js";
import { createActionRepository } from "../adapters/storage/action-repository.js";
import { createMonitorRepository } from "../adapters/storage/monitor-repository.js";
import { createMemoryRepository } from "../adapters/storage/memory-repository.js";
import { createIdentityRepository } from "../adapters/storage/identity-repository.js";
import { createSkillRepository } from "../adapters/storage/skill-repository.js";
import { createMessageFeedbackSession } from "../features/messages/service.js";
import { createMessageFeedbackRepository } from "../adapters/storage/message-feedback-repository.js";
import { createHabitsRepository } from "../adapters/storage/habits-repository.js";
import { createHabitsService } from "../features/habits/service.js";
import { createHabitsScheduler } from "../features/habits/scheduler.js";
import { createHabitConsolidationRunner } from "../adapters/pi/habit-runner.js";
import { createInformationRepository } from "../adapters/storage/information-repository.js";
import { createInformationService } from "../features/information/service.js";
import { createInformationScheduler } from "../features/information/scheduler.js";
import {
  createInformationBriefingRunner,
  createInformationRunner,
} from "../adapters/pi/information-runner.js";
import { createNewsScreeningRunner } from "../adapters/pi/news-runner.js";
import {
  createSubagentRegistry,
  type SubagentRegistry,
} from "../features/subagents/registry.js";
import { createBuiltinSubagents } from "../adapters/pi/subagents/catalog.js";
import { openNewsRepository } from "../adapters/storage/news-repository.js";
import { openSqliteDatabase } from "../adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../adapters/storage/sqlite-modules.js";
import { mainSqliteModules } from "../adapters/storage/sqlite-registry.js";
import { createDatabaseToolStore } from "../adapters/storage/database-tool-store.js";
import { createDatabaseService } from "../features/database/database-service.js";
import { fetchRss2 } from "../adapters/news/rss.js";
import { createNewsService } from "../features/news/service.js";
import {
  createNewsScreeningScheduler,
  createNewsScreeningService,
} from "../features/news/screening.js";
import { createHttpApp } from "../http/app.js";
import { createDataLayout, ensureLayout, initializeWorkspaceDocuments, sessionHistoryDir } from "../adapters/storage/data-layout.js";
import { createScheduler } from "../features/jobs/scheduler.js";
import { createWebService } from "../features/web/web-service.js";
import { createHttpWebTransport } from "../adapters/web/http-transport.js";
import { createOpenMeteoTransport } from "../adapters/weather/open-meteo.js";
import { createWeatherService } from "../features/weather/weather-service.js";
import { createBrowserService } from "../features/browser/browser-service.js";
import { createPlaywrightBrowserDriver } from "../adapters/browser/playwright-driver.js";
import { createBrowserDownloadStore } from "../adapters/browser/download-store.js";
import { createSessionHistory } from "../adapters/pi/session-history.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openPi } from "../adapters/pi/session-factory.js";
import { createPiExecution } from "../adapters/pi/execution.js";
import type { ServiceContainer } from "./types.js";
import { createToolPresentation } from "../adapters/ag-ui/tool-presentation.js";
import { createWorkspaceEvents } from "../features/workspace/workspace-events.js";
import { loadSessionRecency } from "../adapters/storage/session-recency.js";
import { createWorkspaceFileService } from "../features/workspace/files-service.js";
import { workspaceFileCommits } from "../adapters/workspace/file-commit-queue.js";
import { createWorkspaceFileStore } from "../adapters/workspace/files-store.js";
import { createActivityService } from "../features/activities/service.js";
import { createDreamRepository } from "../adapters/storage/dream-repository.js";
import { readAssistantInstructions, writeAssistantInstructions } from "../adapters/storage/assistant-instructions.js";
import { createDreamService } from "../features/dream/service.js";
import { createDreamScheduler } from "../features/dream/scheduler.js";
import { createDreamProposer } from "../adapters/pi/dream-runner.js";
import { readDreamTranscript } from "../adapters/pi/session-history.js";
import { createModelTraceReader } from "../adapters/model-trace/reader.js";
import { createModelTraceProxy } from "../adapters/model-trace/proxy.js";
import { withModelTraceExecution } from "../adapters/model-trace/context.js";

/**
 * 应用唯一的运行时组装入口。
 *
 * HTTP、调度器和 pi 都共享这里创建的 memory/jobs/conversation 实例，
 * 避免未来因重复创建 store 而出现两把写锁或两份会话状态。
 */
export const createService = async (config: Config, options: { sharedSkillsDir?: string } = {}): Promise<ServiceContainer & {
  app: Awaited<ReturnType<typeof createHttpApp>>;
  close: () => Promise<void>;
}> => {
  const layout = createDataLayout(config.dataDir);
  await ensureLayout(layout);
  await initializeWorkspaceDocuments(layout);

  const auth = await createAuth(config, layout);
  const recency = await loadSessionRecency(join(layout.stateDir, "session-recency.json"));
  const workspaceEvents = createWorkspaceEvents(recency);
  const workspaceCommits = workspaceFileCommits;

  // main.sqlite 统一管理定时任务、目标、审批、短信与 Dream 机器状态
  const mainDatabase = await openSqliteDatabase(layout.mainDatabaseFile);
  await mainDatabase.serialize(() => ensureSqliteModules(mainDatabase, mainSqliteModules));

  // 记忆与身份是两个独立文件
  const memoryRepository = createMemoryRepository(layout.memoryMarkdownFile);
  const identityRepository = createIdentityRepository(layout.identityFile);
  const identity = createIdentityService(identityRepository, {
    // SOUL/USER 文件实现放 storage adapter；空内容写空文件（等于清空人设）。
    read: (which) => readProfileFile(which === "soul" ? layout.soulFile : layout.userFile, layout.workspaceDir),
    write: (which, content) =>
      writeProfileFile(which === "soul" ? layout.soulFile : layout.userFile, content, undefined, layout.workspaceDir),
  });
  const memory = createMemoryService(memoryRepository, identity);
  const jobs = createJobService(createJobRepository(mainDatabase));
  await jobs.reconcileOnStart();
  const presentation = createToolPresentation(config.presentation);
  // Web 工具是只读能力；未启用时不创建 transport，也不向 pi 声明工具。
  const weather = config.weather.enabled
    ? createWeatherService(createOpenMeteoTransport(config.web), {
        defaultCity: config.weather.defaultCity,
      })
    : undefined;
  const web = config.web.enabled
    ? createWebService(createHttpWebTransport(config.web), {
        searchResults: config.web.searchResults,
        maxSearchResults: 10,
        maxContentChars: config.web.maxContentChars,
      })
    : undefined;
  // 浏览器懒启动：仅配置开启且第一次标签/帧流/Agent 工具需要时才拉起真实 GUI Chrome。
  let browser: ReturnType<typeof createBrowserService> | undefined;
  if (config.browser.enabled) {
    const browserDownloads = createBrowserDownloadStore(layout.browserDownloadsDir);
    await browserDownloads.reconcileOnStart();
    browser = createBrowserService(
      createPlaywrightBrowserDriver({
        profileDir: layout.browserProfileDir,
        executablePath: config.browser.executablePath,
        cdpUrl: config.browser.cdpUrl,
        allowPrivateTargets: config.browser.allowPrivateTargets,
        timeoutMs: config.browser.timeoutMs,
      }),
      browserDownloads,
      {
        onStateChange: (scope, handoff) => workspaceEvents.browserChanged(scope, handoff),
      },
    );
  }
  const goals = createGoalService(createGoalRepository(mainDatabase));
  const actions = createActionService(createActionRepository(mainDatabase), { onChange: (action) => workspaceEvents.approvalChanged(action) });
  const monitors = createMonitorService(createMonitorRepository(layout.monitorsFile));
  const skills = createSkillsService(createSkillRepository(layout, options.sharedSkillsDir));
  const messageFeedbackRepository = createMessageFeedbackRepository(mainDatabase);
  const habitsRepository = createHabitsRepository(mainDatabase);
  const dreamRepository = createDreamRepository(mainDatabase);
  const informationRepository = createInformationRepository(mainDatabase);
  const sessionRepository = createSessionRepository(layout.sessionIndexFile);
  const sessionStorage = createSessionStorage(layout);
  await initializeMainSession(sessionRepository, sessionStorage);
  let information: Awaited<ReturnType<typeof createInformationService>> | undefined;
  let subagents: SubagentRegistry | undefined;

  // 多会话：每个 agent 惰性创建独立的 pi 会话树；用户级能力（memory/jobs/工具）共享。
  // pi runtime 全进程一份：provider 与 runtime key 注册一次，所有线程共用；
  // 每轮会话重建只会重复读 auth 文件与注册表，无收益。
  const modelRuntime = await ModelRuntime.create({
    authPath: layout.piAuthFile,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  // 模型调用全量追踪：注册给 runtime 的 baseUrl 指向本进程内回环记录代理，
  // 代理再原样转发真实 baseUrl。traces.enabled=false（或未配置模型）时不建代理、
  // 不写任何文件，provider 注册与请求行为和原先完全一致。记录代理只绑定
  // 127.0.0.1 随机端口，不进入对外监听；后续组装失败时由各 catch 显式关闭。
  let modelTrace: Awaited<ReturnType<typeof createModelTraceProxy>> | undefined;
  if (config.configured) {
    const runtimeApiKey = config.apiKey || "local-no-key";
    if (config.traces.enabled) {
      modelTrace = await createModelTraceProxy({
        upstreamBaseUrl: config.baseUrl!,
        runtimeApiKey,
        dir: layout.tracesDir,
        maxTotalBytes: config.traces.maxTotalBytes,
      });
    }
    try {
      modelRuntime.registerProvider("personal", {
        baseUrl: modelTrace ? modelTrace.providerBaseUrl : config.baseUrl,
        api: "openai-completions",
        models: [
          {
            id: config.modelId!,
            name: config.modelId!,
            reasoning: false,
            input: ["text", "image"],
            contextWindow: config.contextWindow,
            maxTokens: config.maxTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              maxTokensField: "max_tokens",
            },
          },
        ],
      });
      await modelRuntime.setRuntimeApiKey("personal", runtimeApiKey);
    } catch (error) {
      await modelTrace?.close();
      throw error;
    }
  }

  const touchSession = (id: string) => sessionRepository.update((sessions) => ({
    sessions: sessions.map((session) => session.id === id ? { ...session, updatedAt: new Date().toISOString() } : session),
    result: undefined,
  }));
  const listSessionSnapshots = async () => Promise.all((await sessionRepository.read()).filter((session) => !session.deletion).map(async (session) => {
    let files: string[];
    try { files = (await readdir(sessionHistoryDir(layout, session.id))).filter((file) => file.endsWith(".jsonl")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return session; throw error; }
    const candidates = await Promise.all(files.map(async (file) => ({ file, at: (await stat(join(sessionHistoryDir(layout, session.id), file))).mtimeMs })));
    const latest = candidates.sort((a, b) => b.at - a.at)[0];
    const piSessionId = latest?.file.replace(/\.jsonl$/, "").split("_").slice(1).join("_");
    return { ...session, ...(piSessionId ? { piSessionId } : {}) };
  }));
  const conversationHub = createSessionHub(
    async (sessionId, initialPiSessionId) => {
      const { manager, history, activities } = await createSessionHistory(layout, sessionId, presentation, initialPiSessionId);
      const messages = createMessageFeedbackSession({
        sessionId,
        piSessionId: () => history.piSessionId(),
        facts: history.messageFacts,
        repository: messageFeedbackRepository,
        onFeedbackChanged: async ({ sessionId: fbSessionId, fact, feedback }) => {
          if (fbSessionId !== "main" || fact.domainId !== "sms" || !fact.notificationId || !information) return;
          const signal = await information.buildHabitSignal(fact.notificationId, feedback);
          if (signal) {
            await habits.recordSignal("sms", fact.notificationId, signal);
          }
        },
      });
      return createConversation(config, {
        sessionId,
        history,
        activities,
        messages,
        beginStatus: (input) => workspaceEvents.beginRun(input),
        publishActivity: (overview) => workspaceEvents.activityChanged(overview),
        publishHistoryChange: (identity) => {
          workspaceEvents.conversationHistoryChanged(identity);
          void touchSession(identity.sessionId).catch(() => undefined);
        },
        cancelApprovals: async (ownerSessionId, runId) => {
          for (const action of await actions.list()) if (action.sessionId === ownerSessionId && action.runId === runId && action.status === "pending") await actions.cancel(action.id);
        },
        subscribeApprovals: (ownerSessionId, runId, listener) => actions.subscribe(({ approval }) => {
          if (approval.sessionId === ownerSessionId && approval.runId === runId) {
            listener({ id: approval.id, pending: approval.status === "pending" });
          }
        }),
        openSession: async ({ runId, activity, status, userText }) => {
          await touchSession(sessionId);
          const execution = createPiExecution(
            await openPi({
              config,
              sessionId,
              runId,
              userText,
              activity,
              status,
              presentation,
              modelRuntime,
              layout,
              sessionManager: manager,
              memory,
              jobs: { ...jobs, add: (prompt, daily, at) => conversationHub.withSession(sessionId, () => jobs.add(prompt, daily, at, sessionId)) },
              goals,
              actions,
              actionTimeoutMs: config.writable.actionTimeoutMs,
              monitors: { ...monitors, create: (input) => conversationHub.withSession(sessionId, () => monitors.create({ ...input, originSessionId: sessionId })) },
              web,
              weather,
              browser,
              skills,
              workspaceCommits,
              subagents,
              database,
            }),
            manager,
          );
          // 主聊天（含定时触发与重试）都经此入口驱动模型；只包标签，不改执行语义。
          return withModelTraceExecution(execution, {
            sessionId,
            kind: "chat",
            ...(runId ? { extra: { runId } } : {}),
          });
        },
      });
    },
    listSessionSnapshots,
  );
  const domainInstructions = (file: string) => ({
    read: () => readProfileFile(file, layout.workspaceDir),
    readResolved: () => readResolvedProfileFile(file, layout.workspaceDir),
    inspect: () => inspectProfileFile(file, layout.workspaceDir),
    write: async (text: string) => { await writeProfileFile(file, text, undefined, layout.workspaceDir); },
  });
  const smsInstructions = domainInstructions(layout.smsInstructionsFile);
  const newsInstructions = domainInstructions(layout.newsInstructionsFile);
  // 通用用户习惯定期归纳服务：接管 sms / news 的未消化反馈热缓冲与长期习惯沉淀。
  const habits = createHabitsService({
    repository: habitsRepository,
    domains: [
      {
        id: "sms",
        name: "短信助手",
        summary: "手机短信/外部信息的日常筛选、提醒与静默过滤偏好。",
        readInstructions: () => smsInstructions.readResolved(),
      },
      {
        id: "news",
        name: "新闻助手",
        summary: "RSS 新闻源抓取后的文章兴趣推荐、收藏与跳过偏好。",
        readInstructions: () => newsInstructions.readResolved(),
      },
    ],
    consolidateModel: createHabitConsolidationRunner({ config, layout, modelRuntime }),
    onChanged: (domain) => workspaceEvents.domainChanged(domain, "habits"),
    observeWork: workspaceEvents.presence.observe,
  });
  const habitsScheduler = createHabitsScheduler(habits);
  const informationDeps = {
    observeWork: workspaceEvents.presence.observe,
    retainMain: () => conversationHub.retainSession("main"),
    habits,
    onChanged: (scope: "items" | "runs" | "preferences" | "settings") => workspaceEvents.domainChanged("sms", scope),
    runModel: createInformationRunner({ config, layout, modelRuntime }),
  };
  // 短信领域指令存入工作区，行为习惯与热缓冲统一由 habits 模块托管。
  information = createInformationService({
    ...informationDeps,
    domainId: "sms",
    instructions: smsInstructions,
    synthesizeBriefing: createInformationBriefingRunner({ config, layout, modelRuntime }),
    repository: informationRepository,
  });
  // 新闻事实落 news.sqlite；启动时使用当前数据库路径。
  // Managed 实例唯一，后续 AgentSQL 工具复用同一实例，不另开 writer。
  let newsStorage: Awaited<ReturnType<typeof openNewsRepository>>;
  try {
    newsStorage = await openNewsRepository({
      databaseFile: layout.newsDatabaseFile,
    });
  } catch (error) {
    await Promise.allSettled([mainDatabase.close(), habits.close(), information.close(), conversationHub.closeAll(), browser?.close(), modelTrace?.close()]);
    throw error;
  }
  const newsRepository = newsStorage.repository;
  let databasesClosing = false;
  const database = createDatabaseService(createDatabaseToolStore(async (name) => {
    if (databasesClosing) throw new Error("Managed databases are closing");
    if (name === "news") return newsStorage.database;
    return mainDatabase;
  }));
  const closeDatabases = async () => {
    databasesClosing = true;
    const pending = [newsStorage.database.close(), mainDatabase.close()];
    return Promise.allSettled(pending);
  };
  // 新闻领域读取自己的用户指令文件和通用习惯引擎上下文。
  const newsScreening = createNewsScreeningService({
    observeWork: workspaceEvents.presence.observe,
    repository: newsRepository,
    instructions: newsInstructions,
    habits,
    onFeedbackChanged: (payload) => habits.recordSignal("news", payload.targetId, payload),
    onChanged: (scope) => workspaceEvents.domainChanged("news", scope),
    runModel: createNewsScreeningRunner({ config, layout, modelRuntime }),
  });
  const informationScheduler = createInformationScheduler(information);
  const newsScreeningScheduler = createNewsScreeningScheduler(newsScreening);
  const news = createNewsService({
    observeWork: workspaceEvents.presence.observe,
    repository: newsRepository,
    screening: newsScreening,
    fetchFeed: (url, signal) => fetchRss2(url, config.web, signal),
    onChanged: (scope) => workspaceEvents.domainChanged("news", scope),
  });
  subagents = createSubagentRegistry({
    agents: createBuiltinSubagents({
      config,
      layout,
      modelRuntime,
      information: information!,
      news: {
        preferences: () => news.preferences(),
        query: async (input) => {
          if (input.action === "overview") {
            const [status, sources, preferences, recentArticles] = await Promise.all([
              news.status(),
              news.listSources(),
              news.preferences(),
              news.listArticles({ view: "recommended", savedOnly: false, limit: 5 }),
            ]);
            return {
              status,
              sources: sources.sources,
              preferences,
              recentArticles: recentArticles.articles,
            };
          }
          if (input.action === "items") {
            return news.listArticles({
              view: input.status === "all" ? "all" : "recommended",
              savedOnly: false,
              limit: input.limit ?? 20,
              cursor: input.cursor,
            });
          }
          if (input.action === "item") {
            return news.getArticle(input.itemId ?? "");
          }
          if (input.action === "runs") {
            return newsScreening.listRuns({ status: input.status, limit: input.limit, cursor: input.cursor });
          }
          return newsScreening.getRun(input.runId ?? "");
        },
      },
      browser,
    }),
  });

  // 先完整读取/校验并恢复各域，再启动任何执行源。初始化失败不会遗留 interval。
  try {
    await Promise.all([memory.list(), identity.get(), goals.list(), actions.list(), monitors.list(), dreamRepository.reconcileOnStart(), habitsRepository.validateAll(), messageFeedbackRepository.validateAll(), informationRepository.validateAll(), informationRepository.reconcileOnStart(), newsRepository.validate(), newsRepository.reconcileOnStart?.()]);
    await actions.cancelPending();
    workspaceEvents.seedApprovals(await actions.list());
  } catch (error) {
    await Promise.allSettled([habits.close(), information?.close(), newsScreening.close(), news.close(), conversationHub.closeAll(), browser?.close(), modelTrace?.close()]);
    await closeDatabases();
    throw error;
  }
  let mainConversation: Awaited<ReturnType<typeof conversationHub.forSession>>;
  try {
    mainConversation = await conversationHub.forSession("main");
    await news.initialize();
  } catch (error) {
    await news.close();
    await Promise.allSettled([habits.close(), information?.close(), newsScreening.close(), news.close(), conversationHub.closeAll(), browser?.close(), modelTrace?.close()]);
    await closeDatabases();
    throw error;
  }
  const scheduleBlocked = (sessionId: string, id: string): boolean =>
    conversationHub.isDeleting(sessionId) || sessions.isScheduleBlocked(id);
  const scheduler = createScheduler(config, jobs, mainConversation, (sessionId) => conversationHub.findSession(sessionId), scheduleBlocked);
  const monitorScheduler = createMonitorScheduler(
    { monitorScanIntervalMs: config.monitorScanIntervalMs, web }, monitors,
    mainConversation, (sessionId) => conversationHub.findSession(sessionId), scheduleBlocked,
  );
  let closed = false;
  let approvalExpiry: Promise<unknown> | undefined;
  const approvalTimer = setInterval(() => {
    if (!closed && !approvalExpiry) {
      approvalExpiry = actions.expirePending().catch(() => undefined).finally(() => { approvalExpiry = undefined; });
    }
  }, 1_000);
  approvalTimer.unref();
  let closing: Promise<void> | undefined;
  const requests = new Set<Promise<void>>();
  const lifecycle = {
    isClosing: () => closed,
    enter: () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      requests.add(pending);
      return () => { requests.delete(pending); release(); };
    },
  };
  const activities = createActivityService(conversationHub);
  const dream = createDreamService({
    observeWork: workspaceEvents.presence.observe,
    waitingChanged: (sessionId, waiting) => workspaceEvents.presence.set(sessionId, "dream-pending", waiting ? { state: "waiting", label: "记忆整理有待确认建议，请查看 Dream" } : null),
    repository: dreamRepository,
    notes: {
      readUser: () => readProfileFile(layout.userFile, layout.workspaceDir),
      readResolvedUser: () => readResolvedProfileFile(layout.userFile, layout.workspaceDir),
      writeUserIfUnchanged: (content, expected) => identity.writeIfUnchanged("user", content, expected),
      readSoul: () => readProfileFile(layout.soulFile, layout.workspaceDir),
      readResolvedSoul: () => readResolvedProfileFile(layout.soulFile, layout.workspaceDir),
      writeSoulIfUnchanged: (content, expected) => identity.writeIfUnchanged("soul", content, expected),
      readInstructions: () => readAssistantInstructions(layout.assistantInstructionsFile, layout.workspaceDir),
      readResolvedInstructions: () => readResolvedProfileFile(layout.assistantInstructionsFile, layout.workspaceDir),
      writeInstructionsIfUnchanged: (content, expected) =>
        writeAssistantInstructions(layout.assistantInstructionsFile, content, expected, layout.workspaceDir),
    },
    memory,
    conversations: {
      listSessionIds: async () => (await conversationHub.sessions()).map((item) => item.id),
      sessionExists: async (sessionId) =>
        sessionId === "main" || (await conversationHub.findSession(sessionId)) !== undefined,
      isSessionBusy: async (sessionId) =>
        (await conversationHub.findSession(sessionId))?.isRunning() ?? false,
      readTranscript: (sessionId) => readDreamTranscript(layout, sessionId),
    },
    propose: createDreamProposer({ config, layout, modelRuntime }),
  });
  const dreamScheduler = createDreamScheduler(dream);
  const companions = createCompanionService(createCompanionStore(layout));
  const workspaceFiles = createWorkspaceFileService(createWorkspaceFileStore(layout, workspaceCommits));
  const sessions = createSessionService({ repository: sessionRepository, storage: sessionStorage, hub: conversationHub,
    jobs, monitors, actions, feedback: messageFeedbackRepository, pauseMain: () => information!.pause(),
    forgetPresence: workspaceEvents.presence.forget, publishHistoryChange: workspaceEvents.conversationHistoryChanged,
    isJobRunning: scheduler.isRunningFor,
    settleMonitorDeliveries: monitorScheduler.settleDeliveriesFor });
  // 读取器不依赖记录开关：关闭新记录后，既有诊断仍可读取；缺目录为空集。
  const traces = createModelTraceReader(layout.tracesDir);
  const androidUpdates = createAndroidReleaseMirror(layout.androidUpdatesDir);
  const dependencies = { androidUpdates, companions, traces, config, layout, auth, memory, identity, jobs, goals, actions, monitors, monitorScheduler, conversationHub, scheduler, presentation, lifecycle, skills, workspaceEvents, workspaceFiles, workspaceCommits, activities, dream, dreamScheduler, habits, habitsScheduler, information, informationScheduler, news, subagents, newsRepository, newsDatabase: newsStorage.database, database, sessions, browser, messageFeedbackRepository };
  const close = () => {
    if (closing) return closing;
    // 同步关门，所有执行源停止派发；并发取消会话，最后等待结果/HTTP 写入收尾。
    closed = true;
    databasesClosing = true;
    clearInterval(approvalTimer);
    // 全局通知没有执行取消语义；先结束长连接，避免 HTTP server 等待它们而无法退出。
    workspaceEvents.close();
    const stopped = [androidUpdates.close(), scheduler.close(), monitorScheduler.close(), dreamScheduler.close(), habitsScheduler.close(), informationScheduler.close(), information?.close() ?? Promise.resolve(), news.close(), newsScreening.close(), newsScreeningScheduler.close(), conversationHub.closeAll()];
    closing = (async () => {
      const results = await Promise.allSettled(stopped);
      await Promise.all([...requests]);
      await approvalExpiry;
      // 新闻写方与在途请求都收尾后再关库；之后不再接受任何 news_* 写入。
      results.push(...await closeDatabases());
      await browser?.close();
      await recency.flush();
      // 执行源收尾后再关记录代理：取消产生的 abort/断流 trace 先完成旁路写入。
      await modelTrace?.close();
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return closing;
  };
  try {
    await sessions.recoverDeletions();
    await dream.describeAll();
    const app = await createHttpApp(dependencies);
    scheduler.start();
    monitorScheduler.start();
    dreamScheduler.start();
    habitsScheduler.start();
    informationScheduler.start();
    newsScreeningScheduler.start();
    news.start();
    return { ...dependencies, app, close };
  } catch (error) {
    await close();
    throw error;
  }
};
