import { randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isWorkspaceText } from "../../shared/workspace-text.js";
import { safeWorkspacePath } from "../pi/tools/workspace-path.js";
import { workspaceFileCommits } from "../workspace/file-commit-queue.js";

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

const readText = async (file: string): Promise<string> => {
  try {
    // 以非阻塞方式打开再校验类型，拒绝符号链接与 FIFO。
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw Object.assign(new Error("Not a regular settings file"), { code: "EISDIR" });
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await handle.readFile());
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissing(error)) return "";
    throw error;
  }
};

/** 空文件就是空设置。权限和字节解码失败必须可见。 */
export const readProfileFile = async (file: string, workspaceBoundary?: string): Promise<string> => {
  const target = workspaceBoundary
    ? await safeWorkspacePath(workspaceBoundary, file, { allowMissing: true })
    : file;
  return readText(target);
};

/** 设置和自动整理在工作区的逐路径锁内比较、原样写入并原子替换文本。 */
export const writeProfileFile = async (
  file: string,
  content: string,
  expected?: string,
  workspaceBoundary?: string,
): Promise<boolean> => {
  if (workspaceBoundary && !isWorkspaceText(content)) throw new Error("Invalid workspace text");
  // 先确定锁键再执行异步检查；同一入口的提交顺序不会被路径查询重排。
  const target = workspaceBoundary
    ? join(realpathSync(dirname(workspaceBoundary)), basename(workspaceBoundary), relative(workspaceBoundary, file))
    : resolve(file);
  return workspaceFileCommits(target, async () => {
    if (!workspaceBoundary) await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (workspaceBoundary && await safeWorkspacePath(workspaceBoundary, file, { allowMissing: true }) !== target)
      throw new Error("Workspace path changed");
    if (expected !== undefined && await readText(target) !== expected) return false;
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      if (workspaceBoundary && await safeWorkspacePath(workspaceBoundary, file, { allowMissing: true }) !== target)
        throw new Error("Workspace path changed");
      await rename(temporary, target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") await unlink(temporary).catch(() => undefined);
      throw error;
    }
  });
};
