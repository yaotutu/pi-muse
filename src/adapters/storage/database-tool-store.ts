import { constants, type DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import { checkDatabaseCancellation, DatabaseToolError, type DatabaseFailureOutcome } from "../../features/database/errors.js";
import type { DatabaseToolStore } from "../../features/database/port.js";
import type {
  DatabaseExecution, DatabaseExecutionResult, DatabaseName,
  DatabaseStatement, DatabaseValue,
} from "../../features/database/types.js";

/** Structural dependency: bootstrap supplies the same connection/queue used by repositories. */
export interface DatabaseToolConnection {
  database: DatabaseSync;
  serialize<T>(work: () => T | Promise<T>): Promise<T>;
  transaction<T>(work: () => T): T;
}
export type GetToolDatabase = (name: DatabaseName) => Promise<DatabaseToolConnection>;

// Only trailing trivia is recognized here; SQLite itself parses statement boundaries (including triggers).
const trailingTrivia = /^(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$/;
const safeModules = new Set(["fts3", "fts4", "fts5", "fts3tokenize", "fts4aux", "fts5vocab", "rtree", "rtree_i32", "geopoly"]);
const safeExtensionFunctions = new Set([
  "bm25", "highlight", "snippet", "match", "matchinfo", "offsets", "optimize",
  "fts5", "fts5_source_id", "fts5_locale", "fts5_insttoken", "fts5_get_locale",
  "rtreecheck", "rtreenode", "rtreedepth",
  "geopoly_bbox", "geopoly_overlap", "geopoly_contains_point", "geopoly_regular", "geopoly_json",
  "geopoly_xform", "geopoly_within", "geopoly_ccw", "geopoly_debug", "geopoly_blob", "geopoly_area",
  "geopoly_svg", "geopoly_group_bbox",
]);
const unsafePragmas = new Set(["temp_store_directory", "data_store_directory", "writable_schema"]);
const queryPragmasWithArgument = new Set([
  "table_info", "table_xinfo", "table_list", "index_info", "index_xinfo", "index_list",
  "foreign_key_list", "foreign_key_check", "integrity_check", "quick_check",
]);
const transactionalPragmas = new Set(["user_version", "application_id", "schema_version"]);

function valueToJson(value: SQLOutputValue): DatabaseValue {
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (value instanceof Uint8Array) return { type: "blob", base64: Buffer.from(value).toString("base64") };
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { type: "number", value: Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity" };
  }
  return value;
}

function setBindingOptions(statement: StatementSync): void {
  // Keep binding names exact: :name/@name/$name, with no silent unused bindings.
  statement.setAllowBareNamedParameters(false);
  statement.setAllowUnknownNamedParameters(false);
}

function totalChanges(database: DatabaseSync): bigint {
  const statement = database.prepare("SELECT total_changes() AS n");
  statement.setReadBigInts(true);
  return statement.get()!.n as bigint;
}

/** All authorizer changes, SQL and cleanup stay inside the shared serialize callback. */
export function createDatabaseToolStore(getDatabase: GetToolDatabase): DatabaseToolStore {
  return {
    async execute(request, signal) {
      checkDatabaseCancellation(signal);
      try {
        const managed = await getDatabase(request.database);
        checkDatabaseCancellation(signal);
        return await managed.serialize(() => executeSerialized(managed, request, signal));
      } catch (error) {
        if (error instanceof DatabaseToolError) throw error;
        // Opening/queue failures must not reveal configured paths or upstream diagnostics.
        throw new DatabaseToolError("unavailable", "unknown");
      }
    },
  };
}

function executeSerialized(managed: DatabaseToolConnection, request: DatabaseExecution, signal?: AbortSignal): DatabaseExecutionResult {
  checkDatabaseCancellation(signal);
  const database = managed.database;
  if (database.isTransaction) throw new DatabaseToolError("unavailable", "not_started");
  const result: DatabaseExecutionResult = {
    database: request.database,
    atomic: request.atomic,
    results: request.statements.map(() => ({ columns: [], rows: [], changes: "0", rowsTruncated: false, columnsTruncated: false })),
    limits: { maxRows: request.maxRows, maxBytes: request.maxBytes },
    truncated: false,
  };
  // Reserve metadata growth (64-bit change counters/truncation markers for all 16 statements).
  // Count each column/row once rather than repeatedly serializing an ever-growing response.
  let remainingBytes = request.maxBytes - Buffer.byteLength(JSON.stringify(result), "utf8") - 1024;
  let denied: "host_boundary" | "unsupported_sql" | undefined;
  let executing = false;
  let started = false;
  let index = 0;
  let callbackFailure: unknown;
  let callbackCompleted = false;
  let outcome: DatabaseFailureOutcome = "not_started";

  // Builtin SQLite functions plus known bundled FTS/geometry helpers, not arbitrary host callbacks.
  const safeFunctions = new Set(database.prepare("SELECT DISTINCT name FROM pragma_function_list WHERE builtin = 1").all()
    .map((row) => String(row.name).toLowerCase()));
  safeFunctions.delete("load_extension");
  for (const name of safeExtensionFunctions) safeFunctions.add(name);

  // SQL extension loading stays disabled even if SQL later persists a view/trigger containing it.
  database.enableLoadExtension(false);
  const authorize: Parameters<DatabaseSync["setAuthorizer"]>[0] = (action, first, second) => {
    const reject = (code: "host_boundary" | "unsupported_sql" = "host_boundary") => { denied = code; return constants.SQLITE_DENY; };
    if (action === constants.SQLITE_ATTACH) {
      // VACUUM internally attaches an anonymous database while stepping. Explicit ATTACH is denied
      // at prepare, and VACUUM INTO filenames (including bound/computed expressions) are denied here.
      return executing && first === "" ? constants.SQLITE_OK : reject();
    }
    if (action === constants.SQLITE_DETACH || action === constants.SQLITE_SAVEPOINT) return reject();
    if (action === constants.SQLITE_TRANSACTION) return executing ? constants.SQLITE_OK : reject();
    if (action === constants.SQLITE_PRAGMA) {
      const name = (first ?? "").toLowerCase();
      if (unsafePragmas.has(name)) return reject();
      // EXCLUSIVE mode retains database file locks after statements finish. Unknown values are
      // rejected too: SQLite may treat them as a query and silently retain a previous mode.
      if (name === "locking_mode" && second !== null && second.toLowerCase() !== "normal") return reject("unsupported_sql");
      if (second !== null && !queryPragmasWithArgument.has(name)) {
        if (request.atomic && !transactionalPragmas.has(name)) return reject("unsupported_sql");
        // Some connection PRAGMAs take effect during prepare(), before sourceSQL is available.
        // A later tail/binding failure must not assert that no state could have changed.
        if (!request.atomic) started = true;
      }
    }
    if (action === constants.SQLITE_FUNCTION && !safeFunctions.has((second ?? "").toLowerCase())) return reject();
    if (action === constants.SQLITE_CREATE_VTABLE && !safeModules.has((second ?? "").toLowerCase())) return reject();
    return constants.SQLITE_OK;
  };

  const run = () => {
    database.setAuthorizer(authorize);
    try {
      for (index = 0; index < request.statements.length; index++) {
        checkDatabaseCancellation(signal);
        const input: DatabaseStatement = request.statements[index]!;
        const output = result.results[index]!;
        denied = undefined;
        executing = false;
        const statement = database.prepare(input.sql);
        // prepare() silently accepts only the first statement. Never drop the unparsed tail.
        if (!trailingTrivia.test(input.sql.slice(statement.sourceSQL.length))) {
          throw new DatabaseToolError("invalid_request", "not_started", index);
        }
        statement.setReadBigInts(true);
        statement.setReturnArrays(true);
        setBindingOptions(statement);
        const columns = statement.columns();
        output.columns = columns.map((column) => column.name);
        const columnBytes = Buffer.byteLength(JSON.stringify(output.columns), "utf8") - 2;
        if (columnBytes > remainingBytes) {
          output.columns = [];
          output.columnsTruncated = true;
          result.truncated = true;
        } else remainingBytes -= columnBytes;
        const before = totalChanges(database);
        checkDatabaseCancellation(signal);
        executing = true;
        started = true;
        if (columns.length) {
          const iterator = input.params === undefined ? statement.iterate()
            : Array.isArray(input.params) ? statement.iterate(...input.params) : statement.iterate(input.params);
          const rows = iterator as unknown as Iterable<SQLOutputValue[]>;
          // Breaking iteration resets the statement, releasing cursors/locks. SQLite performs all
          // DML RETURNING mutations on the first step; stopping output does not rewrite/replay SQL.
          for (const row of rows) {
            if (signal?.aborted) throw new DatabaseToolError("cancelled", "unknown", index);
            if (output.rows.length >= request.maxRows) {
              output.rowsTruncated = "max_rows";
              break;
            }
            if (output.columnsTruncated) {
              output.rowsTruncated = "max_bytes";
              break;
            }
            const encoded = row.map(valueToJson);
            const rowBytes = Buffer.byteLength(JSON.stringify(encoded), "utf8") + (output.rows.length ? 1 : 0);
            if (rowBytes > remainingBytes) {
              output.rowsTruncated = "max_bytes";
              break;
            }
            output.rows.push(encoded);
            remainingBytes -= rowBytes;
          }
        } else if (input.params === undefined) statement.run();
        else if (Array.isArray(input.params)) statement.run(...input.params);
        else statement.run(input.params);
        executing = false;
        output.changes = (totalChanges(database) - before).toString();
        if (output.rowsTruncated) result.truncated = true;
      }
      callbackCompleted = true;
      return result;
    } catch (error) {
      callbackFailure = error;
      throw error;
    } finally {
      executing = false;
      // The shared queue excludes repository access while this connection-local guard is installed.
      database.setAuthorizer(null);
    }
  };

  try {
    const completed = request.atomic ? managed.transaction(run) : run();
    // Do not re-check cancellation after commit: a late Stop must not claim that writes did not occur.
    return completed;
  } catch (error) {
    outcome = request.atomic && error === callbackFailure && !callbackCompleted && !database.isTransaction
      ? "rolled_back" : started ? "unknown" : "not_started";
    const code = error instanceof DatabaseToolError ? error.code : denied ?? "sql_error";
    throw new DatabaseToolError(code, outcome, index < request.statements.length ? index : undefined);
  } finally {
    // Explicit BEGIN/SAVEPOINT cannot pass the authorizer. Still close any unexpected transaction
    // created by a maintenance statement or a failing manager; never leave a lock for another call.
    if (database.isTransaction) {
      try { database.exec("ROLLBACK"); }
      catch { throw new DatabaseToolError("unavailable", "unknown", index); }
    }
  }
}
