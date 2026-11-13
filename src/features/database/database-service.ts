import { checkDatabaseCancellation, DatabaseToolError } from "./errors.js";
import type { DatabaseToolStore } from "./port.js";
import type { DatabaseParameters, DatabaseRequest, DatabaseResult, DatabaseStatement } from "./types.js";

export const DATABASE_LIMITS = {
  defaultRows: 200, maxRows: 1000,
  defaultBytes: 65_536, minBytes: 8192, maxBytes: 262_144,
  maxStatements: 16, maxSqlChars: 65_536, maxParameterChars: 65_536,
} as const;

const schemaSql = "SELECT 'main' AS schema, type, name, tbl_name, rootpage, sql FROM main.sqlite_schema " +
  "UNION ALL SELECT 'temp', type, name, tbl_name, rootpage, sql FROM temp.sqlite_schema ORDER BY schema, type, name";
const invalid = (): never => { throw new DatabaseToolError("invalid_request", "not_started"); };

function validateParameters(params: DatabaseParameters | undefined): void {
  if (params === undefined) return;
  if (params === null || typeof params !== "object") invalid();
  if (!Array.isArray(params) && Object.getPrototypeOf(params) !== Object.prototype && Object.getPrototypeOf(params) !== null) invalid();
  const entries = Object.entries(params);
  if (entries.length > 1000) invalid();
  for (const [key, value] of entries) {
    if (key.length > 256) invalid();
    if (value !== null && typeof value !== "string" && typeof value !== "number") invalid();
    if (typeof value === "string" && value.length > DATABASE_LIMITS.maxParameterChars) invalid();
    if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) invalid();
  }
}

function validateStatement(statement: DatabaseStatement): void {
  if (!statement || typeof statement.sql !== "string" || !statement.sql.trim() ||
    statement.sql.length > DATABASE_LIMITS.maxSqlChars || statement.sql.includes("\0")) invalid();
  validateParameters(statement.params);
}

export function createDatabaseService(store: DatabaseToolStore) {
  return {
    async execute(request: DatabaseRequest, signal?: AbortSignal): Promise<DatabaseResult> {
      checkDatabaseCancellation(signal);
      if (!request || !["list", "schema", "execute"].includes(request.action)) invalid();
      if (request.database !== undefined && request.database !== "main" && request.database !== "news") invalid();
      const maxRows = request.maxRows ?? DATABASE_LIMITS.defaultRows;
      const maxBytes = request.maxBytes ?? DATABASE_LIMITS.defaultBytes;
      if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > DATABASE_LIMITS.maxRows ||
        !Number.isInteger(maxBytes) || maxBytes < DATABASE_LIMITS.minBytes || maxBytes > DATABASE_LIMITS.maxBytes) invalid();
      if (request.action !== "execute" && (request.sql !== undefined || request.params !== undefined || request.statements !== undefined)) invalid();
      if (request.action === "list") return { databases: [{ name: "main", default: true }, { name: "news", default: false }] };
      let statements: DatabaseStatement[];
      let atomic = false;
      if (request.action === "schema") statements = [{ sql: schemaSql }];
      else if (request.statements !== undefined) {
        if (request.sql !== undefined || request.params !== undefined || !Array.isArray(request.statements) ||
          !request.statements.length || request.statements.length > DATABASE_LIMITS.maxStatements) invalid();
        statements = request.statements;
        atomic = true;
      } else {
        if (request.sql === undefined) return invalid();
        statements = [{ sql: request.sql, params: request.params }];
      }
      statements.forEach(validateStatement);
      return store.execute({ database: request.database ?? "main", statements, atomic, maxRows, maxBytes }, signal);
    },
  };
}

export type DatabaseService = ReturnType<typeof createDatabaseService>;
