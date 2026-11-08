import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { modelTraceRecordSchema, traceFileNameSchema } from "./schema.js";
import type { ModelTraceRecord } from "./store.js";

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const namePattern = /^\d{6}-\d{3}-[A-Za-z0-9_-]+-\d{6,}\.json$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const reportBadFile = () => console.error("[pi-muse/model-trace] trace read failed: INVALID_TRACE");

/** 只读诊断读取器：从不创建目录或修改记录，也不将内容注入任何模型上下文。 */
export const createModelTraceReader = (dir: string) => {
  const root = resolve(dir);
  const read = async (fileName: string): Promise<ModelTraceRecord | undefined> => {
    if (!traceFileNameSchema.safeParse(fileName).success) return undefined;
    const day = fileName.slice(0, 10);
    const name = fileName.slice(11);
    let handle;
    try {
      // 拒绝根、日目录及文件上的符号链接；O_NOFOLLOW 再保护最终文件打开。
      // 先规范化系统祖先路径（macOS /var -> /private/var），但不允许日目录越界。
      if ((await lstat(root)).isSymbolicLink()) throw new Error("Invalid trace root");
      const canonicalRoot = await realpath(root);
      const dayPath = join(canonicalRoot, day);
      if (!(await lstat(dayPath)).isDirectory() || (await realpath(dayPath)) !== dayPath) throw new Error("Invalid trace day");
      handle = await open(join(dayPath, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!(await handle.stat()).isFile()) throw new Error("Invalid trace file");
      // 返回值显式采用一期类型，读取 schema 有漂移时由赋值检查与往返测试阻止。
      return modelTraceRecordSchema.parse(JSON.parse(await handle.readFile("utf8")));
    } catch (error) {
      if (!missing(error)) reportBadFile();
      return undefined;
    } finally {
      await handle?.close();
    }
  };

  return {
    read,
    /** 损坏或不可读的单条只跳过并计数；根目录读取失败仍是服务故障，缺目录则为空集。 */
    list: async () => {
      let days;
      try {
        // 未开启记录时目录可能不存在，不创建它。
        if ((await lstat(root)).isSymbolicLink()) throw new Error("Invalid trace root");
        days = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if (missing(error)) return { records: [], badCount: 0 };
        throw error;
      }
      const records: Array<{ fileName: string; record: ModelTraceRecord }> = [];
      let badCount = 0;
      for (const day of days) {
        if (!dayPattern.test(day.name)) continue;
        if (!day.isDirectory() || day.isSymbolicLink()) { badCount += 1; reportBadFile(); continue; }
        let names;
        try { names = await readdir(join(root, day.name)); }
        catch { badCount += 1; reportBadFile(); continue; }
        for (const name of names) {
          if (!namePattern.test(name)) continue;
          const fileName = `${day.name}.${name}`;
          const record = await read(fileName);
          if (record) records.push({ fileName, record });
          else badCount += 1;
        }
      }
      return { records, badCount };
    },
  };
};
export type ModelTraceReader = ReturnType<typeof createModelTraceReader>;
