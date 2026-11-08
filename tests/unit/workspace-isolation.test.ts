import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isSessionId } from "../../src/features/conversation/session-id.js";
import {
  createDataLayout,
  ensureLayout,
} from "../../src/adapters/storage/data-layout.js";
import { createFileTools } from "../../src/adapters/pi/tools/files.js";
import { createWritableFileTools } from "../../src/adapters/pi/tools/files-writable.js";
import {
  resolveWorkspacePath,
  safeWorkspacePath,
  UnsafeFilePathError,
} from "../../src/adapters/pi/tools/workspace-path.js";
import { createActionService, type ActionService } from "../../src/features/actions/action-service.js";
import type { ActionRepository, PendingAction } from "../../src/features/actions/types.js";

/** 串行读改写的内存审批仓库；不触动正式 .pi-muse，仅用于本地测试隔离。 */
const memoryRepository = (initial: PendingAction[] = []): ActionRepository => {
  let items = structuredClone(initial);
  let tail = Promise.resolve();
  return {
    read: async () => { await tail; return structuredClone(items); },
    update: <T>(change: (items: PendingAction[]) => { items?: PendingAction[]; result: T }) => {
      const result = tail.then(() => {
        const next = change(structuredClone(items));
        if (next.items) items = structuredClone(next.items);
        return next.result;
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

/** 所有文件工具遵循相同的 pi execute 签名；以 `as never` 跳过 SDK 的 schema 强约束并断言 content/details。 */
type Tools = ReturnType<typeof createFileTools>;
type WriteTools = ReturnType<typeof createWritableFileTools>;
type ToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string; note?: string }>;
  details?: unknown;
  isError?: boolean;
};
const callTool = (tool: Tools[number] | WriteTools[number], params: unknown) =>
  (tool.execute as (id: string, params: unknown, signal: undefined, update: undefined, ctx: never) => Promise<ToolResult>)(
    "test-call", params, undefined, undefined, {} as never,
  );

/** 工具装载统一入口；boundaryDir 限制跨容器链接替换与边界外的父目录回退。 */
const setupWorkspace = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-boundaries-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const layout = createDataLayout(directory);
  await ensureLayout(layout);
  const rootA = layout.workspaceDir;
  const toolsA = createFileTools(rootA, { boundaryDir: layout.workspaceDir });
  const toolsB = createFileTools(rootA, { boundaryDir: layout.workspaceDir });
  return { directory, layout, rootA, rootB: rootA, sharedDir: rootA, toolsA, toolsB };
};

const den = (result: { isError?: boolean; details?: unknown }) => {
  assert.equal(result.isError, true);
  const details = result.details as { denied?: boolean };
  assert.equal(details?.denied, true);
};

const findTool = (tools: Tools) => tools.find((tool) => tool.name === "find")!;
const readTool = (tools: Tools) => tools.find((tool) => tool.name === "read")!;
const grepTool = (tools: Tools) => tools.find((tool) => tool.name === "grep")!;
const lsTool = (tools: Tools) => tools.find((tool) => tool.name === "ls")!;

/** 1×1 RGB PNG，IHDR/IDAT/IEND 均包含有效 CRC，保留 pi 原生图片处理链路。 */
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

test("layout has one flat workspace and only main or UUID session ids", async (t) => {
  const { layout } = await setupWorkspace(t);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(layout.workspaceDir), []);
  for (const id of ["main", "00000000-0000-4000-8000-000000000001"]) assert.equal(isSessionId(id), true);
  for (const id of ["", "task-any", "legacy-main", "trip-2026", "../escape"]) assert.equal(isSessionId(id), false);
});

test("both conversations read the same flat files while traversal and absolute paths stay denied", async (t) => {
  const { rootA, toolsA, toolsB } = await setupWorkspace(t);
  await writeFile(join(rootA, "note.md"), "common workspace");
  for (const tools of [toolsA, toolsB]) {
    assert.match((await callTool(readTool(tools), { path: "note.md" })).content[0].text ?? "", /common workspace/);
    for (const path of ["../note.md", "/etc/passwd", "..\\note.md"]) den(await callTool(readTool(tools), { path }));
    den(await callTool(grepTool(tools), { pattern: "x", path: ".." }));
    den(await callTool(findTool(tools), { pattern: "*", path: ".." }));
    den(await callTool(lsTool(tools), { path: ".." }));
  }
  // 普通相对目录不是前缀别名；不存在就保持 not-found，不能跳到另一个根。
  den(await callTool(readTool(toolsA), { path: "shared/note.md" }));
});

// 3. 符号链接（文件、目录、断链）无论直接还是递归访问，都不能跟随到另一会话/实例配置/外部目录/shared/同根环回。
test("symlinks are never dereferenced even when listed or discovered through find", async (t) => {
  const { directory, rootA, rootB, sharedDir, layout, toolsA } = await setupWorkspace(t);
  const outside = join(directory, "outside");
  const otherRoot = join(directory, "trip-note.md");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.md"), "OUTSIDE-CONTENT");
  await writeFile(join(outside, "deeper.txt"), "OUTSIDE-DEEPER");
  await mkdir(join(outside, "sub"), { recursive: true });
  await writeFile(join(outside, "sub/hidden.md"), "OUTSIDE-HIDDEN");
  await writeFile(otherRoot, "OTHER-SESSION-CONTENT");
  await writeFile(join(layout.root, "config.json"), JSON.stringify({ token: "INSTANCE-CONFIG" }));
  await writeFile(join(directory, "shared-secret.md"), "SHARED-CONTENT");

  // 在 A 的私有目录中创建指向目标的链接；目标内容必须不被任何工具读取。
  await symlink(join(outside, "secret.md"), join(rootA, "link-file"));
  await symlink(outside, join(rootA, "link-dir"));
  await symlink(join(layout.root, "config.json"), join(rootA, "link-config"));
  await symlink(otherRoot, join(rootA, "link-other-session"));
  await symlink(join(directory, "shared-secret.md"), join(rootA, "link-shared"));
  await symlink(rootA, join(rootA, "self-loop"));
  await symlink(join(outside, "does-not-exist"), join(rootA, "broken-link"));

  const denials = ["link-file", "link-dir", "link-config", "link-other-session", "link-shared", "self-loop", "broken-link"];
  for (const path of denials) {
    den(await callTool(readTool(toolsA), { path }));
    den(await callTool(grepTool(toolsA), { pattern: "anything", path }));
    den(await callTool(findTool(toolsA), { pattern: "*", path }));
    den(await callTool(lsTool(toolsA), { path }));
  }
  // find 暴露根名时，链接本身的 fs 名字可能会出现，但目标/后代文件与外部内容不能被列出
  const findResult = await callTool(findTool(toolsA), { pattern: "**/*" });
  assert.equal(findResult.isError, undefined);
  const findOutput = findResult.content[0].text ?? "";
  assert.doesNotMatch(findOutput, /OUTSIDE-CONTENT|OUTSIDE-DEEPER|OUTSIDE-HIDDEN|OTHER-SESSION-CONTENT|INSTANCE-CONFIG|SHARED-CONTENT/);
  for (const forbidden of ["secret.md", "deeper.txt", "hidden.md", "config.json", "trip-note.md", "shared-secret.md"]) {
    assert.doesNotMatch(findOutput, new RegExp(forbidden));
  }

  // 根目录级扫描也必须跳过链接，不能只拦直接访问链接的参数。
  const grepResult = await callTool(grepTool(toolsA), { pattern: "OUTSIDE|OTHER-SESSION|INSTANCE-CONFIG|SHARED-CONTENT", path: "." });
  assert.equal(grepResult.isError, undefined);
  assert.match(grepResult.content[0].text ?? "", /No matches found/);
  const listed = await callTool(lsTool(toolsA), { path: "." });
  assert.equal(listed.isError, undefined);
  assert.doesNotMatch(listed.content[0].text ?? "", /link-|self-loop|broken-link/);
  assert.equal(resolveWorkspacePath(rootA, join(outside, "secret.md")), null);
  await assert.rejects(safeWorkspacePath(rootA, join(outside, "secret.md"), { boundaryDir: layout.workspaceDir }), UnsafeFilePathError);
});

test("layout initialization refuses a linked workspace without creating external directories", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-init-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const layout = createDataLayout(directory);
  const outside = join(directory, "outside");
  await symlink(outside, layout.workspaceDir);
  await assert.rejects(ensureLayout(layout), /Unsafe data directory/);
  const { stat } = await import("node:fs/promises");
  assert.equal(await stat(outside).catch(() => null), null);
  await rm(layout.workspaceDir);
  await ensureLayout(layout);
  assert.equal((await stat(layout.workspaceDir)).isDirectory(), true);
});

// 5. readOnlyFiles 只能让精确 SKILL.md 被读；邻居/同目录其他文件、ls/grep/find 都不放宽；符号链接的 SKILL 必须拒绝。
test("readOnlyFiles opens only the exact SKILL.md path; siblings, listing tools and a symlinked SKILL stay locked", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-iso-skill-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const layout = createDataLayout(directory);
  await ensureLayout(layout);
  // skills 位置与 agent 容器并列；不能因 readOnlyFiles 解锁兄弟目录
  const skillsBase = join(directory, "skills");
  const skillPath = join(skillsBase, "weather", "SKILL.md");
  const siblingPath = join(skillsBase, "weather", "OTHER.md");
  const deepResourcePath = join(skillsBase, "weather", "references", "deep", "note.md");
  await mkdir(join(skillsBase, "weather"), { recursive: true });
  await writeFile(skillPath, "# weather skill\nbody");
  await writeFile(siblingPath, "private neighbour");
  await mkdir(dirname(deepResourcePath), { recursive: true });
  await writeFile(deepResourcePath, "deep resource");
  // agent 里再放一份普通文件，验证 ls/grep/find 不因 SKILL 路径被读取而扩大视野
  const rootA = layout.workspaceDir;
  await writeFile(join(rootA, "inside.md"), "alpha");

  const tools = createFileTools(rootA, {
    boundaryDir: layout.workspaceDir,
    readOnlyFiles: [{
      path: skillPath,
      root: join(skillsBase, "weather"),
      boundaryDir: skillsBase,
    }, {
      path: deepResourcePath,
      root: join(skillsBase, "weather", "references"),
      boundaryDir: skillsBase,
    }],
  });

  // 精确 SKILL.md 路径可读
  const readSkill = await callTool(readTool(tools), { path: skillPath });
  assert.equal(readSkill.isError, undefined);
  const skillText = readSkill.content.map((block) => block.text).join("");
  assert.match(skillText, /weather skill/);
  const readResource = await callTool(readTool(tools), { path: deepResourcePath });
  assert.equal(readResource.isError, undefined);
  assert.match(readResource.content.map((block) => block.text).join(""), /deep resource/);

  // 同目录邻居、其他文件名都必须拒绝
  for (const path of [siblingPath, join(skillsBase, "weather", "ABSENT.md"), join(skillsBase, "weather"), join(skillsBase, "OTHER.md")]) {
    den(await callTool(readTool(tools), { path }));
  }
  // ls/grep/find 不能越过 agent 容器看到 skills：列出的是 agent 的内容
  const ls = await callTool(lsTool(tools), { path: "." });
  assert.equal(ls.isError, undefined);
  assert.match((ls.content[0].text ?? ""), /inside\.md/);
  assert.doesNotMatch((ls.content[0].text ?? ""), /SKILL\.md|sibling|weather/);
  const grep = await callTool(grepTool(tools), { pattern: "weather skill", path: "." });
  assert.equal(grep.isError, undefined);
  assert.doesNotMatch((grep.content[0].text ?? ""), /weather skill/);
  const find = await callTool(findTool(tools), { pattern: "**/*.md" });
  assert.equal(find.isError, undefined);
  assert.doesNotMatch((find.content[0].text ?? ""), /SKILL\.md|OTHER\.md|weather/);

  // 把 SKILL.md 换成符号链接（指向 agent 已有文件），read 仍然拒绝访问
  await rm(skillPath);
  await symlink(join(rootA, "inside.md"), skillPath);
  den(await callTool(readTool(tools), { path: skillPath }));

  // 深层资源同样从 skillsDir 开始复核；中间目录换成链接后不能保留旧授权。
  await rm(join(skillsBase, "weather", "references"), { recursive: true });
  await symlink(rootA, join(skillsBase, "weather", "references"));
  den(await callTool(readTool(tools), { path: deepResourcePath }));

  // 技能根或 skillsDir 本身换成链接同样失效；不能沿用装配时收集的授权。
  await rm(join(skillsBase, "weather"), { recursive: true });
  await symlink(rootA, join(skillsBase, "weather"));
  den(await callTool(readTool(tools), { path: skillPath }));
  den(await callTool(readTool(tools), { path: deepResourcePath }));
  await rm(join(skillsBase, "weather"));
  await rmdir(skillsBase);
  await symlink(rootA, skillsBase);
  den(await callTool(readTool(tools), { path: skillPath }));
});

// 6. PNG 文件读取仍返回 image 类型内容（即便 sandbox 拒绝进入 vision model 渲染）。
test("reading a valid PNG file returns an image content block", async (t) => {
  const { rootA, toolsA } = await setupWorkspace(t);
  const pngPath = join(rootA, "logo.png");
  await writeFile(pngPath, PNG_1X1);
  const result = await callTool(readTool(toolsA), { path: "logo.png" });
  assert.equal(result.isError, undefined);
  const block = result.content.find((content) => content.type === "image");
  assert.ok(block, "expected an image block for a PNG read");
  assert.equal(block?.mimeType, "image/png");
  assert.ok(block?.data && block.data.length > 0, "image block should carry non-empty base64 data");
});

// 7. 两个会话对同一 shared 文件并发提交审批，只能有一个真正写入。
test("two sessions approving the same shared file only let one commit, even when versions race", async (t) => {
  const { directory, layout, rootA, rootB, sharedDir } = await setupWorkspace(t);
  await writeFile(join(sharedDir, "note.md"), "original");
  const repository = memoryRepository();
  const actions = createActionService(repository);

  // 两个动作并发提交审批；同时落定后 commitFile 的共享队列让第一个提交，第二个因版本号变化被拒。
  const ready = deferred<void>();
  let count = 0;
  const approving: Pick<ActionService, "submit" | "poll" | "cancel" | "markExecuting" | "finishExecution"> = {
    markExecuting: actions.markExecuting,
    finishExecution: actions.finishExecution,
    submit: async (...args: Parameters<ActionService["submit"]>) => {
      const action = await actions.submit(...args);
      if (++count === 2) ready.resolve();
      await ready.promise;
      await actions.decide(action.id, "approve");
      return action;
    },
    poll: actions.poll,
    cancel: actions.cancel,
  };
  const factoryA = createWritableFileTools(rootA, approving, 5_000, { sessionId: "main", runId: "run-a" }, layout.workspaceDir);
  const factoryB = createWritableFileTools(rootB, approving, 5_000, { sessionId: "trip-2026", runId: "run-b" }, layout.workspaceDir);
  const writeTool = (tools: WriteTools) => tools.find((tool) => tool.name === "write")!;
  const results = await Promise.all([
    callTool(writeTool(factoryA), { path: "note.md", content: "from-A" }),
    callTool(writeTool(factoryB), { path: "note.md", content: "from-B" }),
  ]);
  const wins = results.filter((result) => !result.isError);
  const losses = results.filter((result) => result.isError === true);
  assert.equal(wins.length, 1, "exactly one session should commit a clean approval");
  assert.equal(losses.length, 1, "the racing approval must be refused for version change");
  // shared 目录只多出一个 note.md，内容来自赢的会话
  const newContent = await readFile(join(sharedDir, "note.md"), "utf8");
  assert.match(newContent, /^(from-A|from-B)$/);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(sharedDir)).sort(), ["note.md"]);
  const decided = await actions.list();
  // 两个 pending 都进入 approved/denied 流程：失败者是基线版本变更被拒绝，不是被人 deny
  assert.equal(decided.length, 2);
  for (const action of decided) {
    assert.equal(action.status === "approved" || action.status === "denied", true);
  }
});
