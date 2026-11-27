export type DatabaseErrorCode = "invalid_request" | "cancelled" | "host_boundary" | "unsupported_sql" | "sql_error" | "unavailable";
export type DatabaseFailureOutcome = "not_started" | "rolled_back" | "unknown";

/** Never attach the SQLite error/cause: it can contain SQL literals, paths or credentials. */
export class DatabaseToolError extends Error {
  constructor(
    public readonly code: DatabaseErrorCode,
    public readonly outcome: DatabaseFailureOutcome,
    /** Zero-based statement index, omitted when no particular statement failed. */
    public readonly statementIndex?: number,
  ) {
    const messages: Record<DatabaseErrorCode, string> = {
      invalid_request: "Invalid database request. Use one SQL statement or a statements array, fixed main name and valid limits/parameters.",
      cancelled: "Database call cancelled before completion.",
      host_boundary: "Only the managed main database is supported. External files, extensions, host functions and explicit transaction control are not supported.",
      unsupported_sql: "This maintenance operation cannot safely run here. Persistent exclusive locking is unsupported; nontransactional connection PRAGMA settings must run as single SQL, not inside an atomic batch.",
      sql_error: "SQLite could not complete this request. Check SQL syntax, bindings, constraints and maintenance/transaction compatibility.",
      unavailable: "Managed database is unavailable or not idle.",
    };
    super(`${messages[code]} Outcome: ${outcome}. Do not automatically retry writes; inspect database state first.`);
    this.name = "DatabaseToolError";
  }
}

export function checkDatabaseCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DatabaseToolError("cancelled", "not_started");
}
