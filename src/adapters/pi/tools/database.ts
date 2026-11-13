import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { DatabaseService } from "../../../features/database/database-service.js";
import { DATABASE_LIMITS } from "../../../features/database/database-service.js";
import { DatabaseToolError } from "../../../features/database/errors.js";

const parameter = Type.Union([Type.String({ maxLength: DATABASE_LIMITS.maxParameterChars }), Type.Number(), Type.Null()]);
const parameters = Type.Union([Type.Array(parameter, { maxItems: 1000 }), Type.Record(Type.String(), parameter)], {
  description: "Positional ? bindings or named bindings with the exact :name/@name/$name prefix. Values are string, finite number or null; bind large integers as decimal strings and CAST in SQL.",
});
const sql = Type.String({ minLength: 1, maxLength: DATABASE_LIMITS.maxSqlChars, description: "Exactly one SQL statement. Use statements for multiple operations; semicolon-separated SQL is rejected, not silently truncated." });

export const databaseTool = (database: Pick<DatabaseService, "execute">) => defineTool({
  name: "database",
  label: "Managed SQLite databases",
  description:
    "Use managed SQLite main (default main.sqlite) or news (news.sqlite). list returns logical database names; schema returns main/temp schema definitions. " +
    "execute accepts either sql plus optional params, OR a nonempty statements array (each entry sql/params) executed atomically in one database transaction. " +
    "Freely SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER or DROP any business table: no table ACL or approval. " +
    "Ordinary PRAGMA and VACUUM are supported where SQLite permits; use a single sql for maintenance incompatible with transactions. " +
    "Connection-level PRAGMA settings are not rollbackable and are rejected in batches (schema/query PRAGMAs and transactional version fields remain supported); persistent exclusive locking is unsupported. " +
    "No explicit BEGIN/COMMIT/SAVEPOINT, ATTACH/DETACH, external file paths, VACUUM INTO files, extension loading or host file/process functions. " +
    "Returns columns and positional rows, decimal changes (total_changes delta including triggers), tagged bigint/blob/nonfinite values, and honest truncation flags. " +
    "maxRows is per statement; maxBytes bounds the whole JSON response. Output truncation does not rewrite SQL or skip later batch statements; it does not mean all rows were returned. " +
    "Cancellation before execution prevents writes; synchronous SQLite already running cannot be interrupted or hard-timed-out. Committed changes are not undone by late cancellation. " +
    "Errors are sanitized; an unknown outcome requires inspecting state, never blindly retrying writes.",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("list"), Type.Literal("schema"), Type.Literal("execute")]),
    database: Type.Optional(Type.Union([Type.Literal("main"), Type.Literal("news")], { description: "Defaults to main. No paths or other databases." })),
    sql: Type.Optional(sql),
    params: Type.Optional(parameters),
    statements: Type.Optional(Type.Array(Type.Object({ sql, params: Type.Optional(parameters) }, { additionalProperties: false }), {
      minItems: 1, maxItems: DATABASE_LIMITS.maxStatements,
      description: "Alternative to sql/params. All statements execute once, in order, in one atomic transaction; failure rolls back the batch. No cross-database transactions.",
    })),
    maxRows: Type.Optional(Type.Integer({ minimum: 1, maximum: DATABASE_LIMITS.maxRows, default: DATABASE_LIMITS.defaultRows })),
    maxBytes: Type.Optional(Type.Integer({ minimum: DATABASE_LIMITS.minBytes, maximum: DATABASE_LIMITS.maxBytes, default: DATABASE_LIMITS.defaultBytes })),
  }, { additionalProperties: false }),
  execute: async (_id, params, signal) => {
    try {
      const result = await database.execute(params, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
    } catch (error) {
      const safe = error instanceof DatabaseToolError ? error : new DatabaseToolError("unavailable", "unknown");
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: { code: safe.code, message: safe.message, outcome: safe.outcome, statementIndex: safe.statementIndex } }) }],
        details: undefined,
        isError: true,
      };
    }
  },
});
