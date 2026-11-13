import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite 基础层：所有关系化业务域（当前为新闻）共用同一 Managed 实例，
 * 后续 AgentSQL 工具也复用该实例，不允许各开 writer 连接。
 *
 * 安全边界：
 * - 拒绝库文件或其父目录为符号链接，防止替换边界绕过 DATA_DIR 隔离。
 * - 库文件与 WAL 边车固定 0600，新建父目录 0700；不隐式 chmod 已有目录。
 *   SQLite 以默认 umask 创建边车，因此在每次事务提交/队列收尾后收紧权限。
 * - 外键约束开启、WAL 日志与有界 busy timeout 在打开时一次性配置。
 */
export type ManagedSqliteDatabase = {
  /** node:sqlite 同步连接；只读查询可直接使用，写入必须经 serialize/transaction 编排。 */
  database: DatabaseSync;
  /** 共享操作队列：同一实例上的异步读改写单元按提交顺序串行执行。 */
  serialize<T>(work: () => T | Promise<T>): Promise<T>;
  /** 同步短事务：work 内禁止出现 Promise/await，返回 Promise 视为编程错误并回滚。 */
  transaction<T>(work: () => T): T;
  /** 拒绝新队列工作并等待在途队列收尾后关闭连接；重复调用返回同一 Promise。 */
  close(): Promise<void>;
};

const BUSY_TIMEOUT_MS = 5_000;
const DATABASE_FILE_MODE = 0o600;
const DATABASE_DIR_MODE = 0o700;

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";

const enforceFileModes = (file: string): void => {
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    let descriptor: number;
    try {
      descriptor = openSync(candidate, constants.O_RDWR | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      if (!fstatSync(descriptor).isFile()) throw new Error("Unsafe database file");
      fchmodSync(descriptor, DATABASE_FILE_MODE);
    } finally {
      closeSync(descriptor);
    }
  }
};

const rejectUnsafeFiles = async (file: string): Promise<void> => {
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      const entry = await lstat(candidate);
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Unsafe database file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
};

export const openSqliteDatabase = async (file: string): Promise<ManagedSqliteDatabase> => {
  const parent = dirname(file);
  // 父目录缺失时先创建，再显式校验不是符号链接；mkdir recursive 以 0700 建链。
  await mkdir(parent, { recursive: true, mode: DATABASE_DIR_MODE });
  const parentEntry = await lstat(parent);
  if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
    throw new Error("Unsafe database directory");
  }
  await rejectUnsafeFiles(file);
  // 在 SQLite 打开之前以 no-follow / 0600 建立文件；边车继承库文件权限。
  const handle = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, DATABASE_FILE_MODE);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Unsafe database file");
    await handle.chmod(DATABASE_FILE_MODE);
  } finally {
    await handle.close();
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(file, {
      enableForeignKeyConstraints: true,
      timeout: BUSY_TIMEOUT_MS,
    });
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    enforceFileModes(file);
  } catch (error) {
    // 初始化失败必须关闭已建立的连接，不留半初始化实例。
    try {
      database!.close();
    } catch {
      // 关闭失败不掩盖原始错误。
    }
    throw error;
  }

  let pending: Promise<unknown> = Promise.resolve();
  let closed = false;
  let inTransaction = false;
  let closing: Promise<void> | undefined;

  const requireOpen = (operation: string) => {
    // close 已关队列入口，但已接纳的异步单元仍需完成其短事务。
    if (!database.isOpen) throw new Error(`Database is closed (${operation})`);
  };

  const serialize = <T>(work: () => T | Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error("Database is closed (serialize)"));
    // 前序单元无论成败都继续执行本单元；队列只保证顺序，不吞当前调用错误。
    const run = pending.then(async () => {
      try {
        return await work();
      } finally {
        // 队列单元内可能有未经 transaction 的直接写入；统一收紧一次边车权限。
        enforceFileModes(file);
      }
    });
    pending = run.catch(() => undefined);
    return run;
  };

  const transaction = <T>(work: () => T): T => {
    requireOpen("transaction");
    if (inTransaction) throw new Error("Nested SQL transactions are not supported");
    database.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    let committed = false;
    try {
      const value = work();
      if (isPromiseLike(value)) {
        throw new Error("Transaction work must stay synchronous; promises cannot cross a SQL transaction");
      }
      database.exec("COMMIT");
      committed = true;
      return value;
    } catch (error) {
      if (!committed) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // 连接已坏时回滚可能失败；保留原始错误交给调用方。
        }
      }
      throw error;
    } finally {
      inTransaction = false;
      enforceFileModes(file);
    }
  };

  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    closing = pending.then(() => {
      try {
        if (database.isOpen) database.close();
      } finally {
        // 正常关闭时 SQLite 自行清理 WAL 边车；异常关闭残留的边车不删除，留给下次打开恢复。
        enforceFileModes(file);
      }
    });
    return closing;
  };

  return { database, serialize, transaction, close };
};
