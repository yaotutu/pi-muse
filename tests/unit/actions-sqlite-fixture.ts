import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActionRepository } from "../../src/adapters/storage/action-repository.js";
import { actionsModule } from "../../src/adapters/storage/actions-schema.js";
import { openSqliteDatabase, type ManagedSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import type { ActionRepository } from "../../src/features/actions/types.js";

/**
 * 审批仓储测试夹具：每个用例独占临时目录与 main.sqlite，
 * 只写隔离数据，不读取也不触碰任何真实实例数据。
 */
export type ActionStore = {
  directory: string;
  databaseFile: string;
  managed: ManagedSqliteDatabase;
  repository: ActionRepository;
  /** 关闭连接并删除临时目录；不负责业务语义。 */
  close: () => Promise<void>;
};

export const openActionStore = async (prefix = "pi-muse-actions-"): Promise<ActionStore> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const databaseFile = join(directory, "main.sqlite");
  const managed = await openSqliteDatabase(databaseFile);
  await managed.serialize(() => ensureSqliteModules(managed, [actionsModule]));
  return {
    directory,
    databaseFile,
    managed,
    repository: createActionRepository(managed),
    close: async () => {
      await managed.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};
