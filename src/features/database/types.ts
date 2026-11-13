export type DatabaseName = "main" | "news";
export type DatabaseParameter = string | number | null;
export type DatabaseParameters = DatabaseParameter[] | Record<string, DatabaseParameter>;
export type DatabaseStatement = { sql: string; params?: DatabaseParameters };

export type DatabaseRequest = {
  action: "list" | "schema" | "execute";
  database?: DatabaseName;
  sql?: string;
  params?: DatabaseParameters;
  /** Each entry is exactly one SQL statement; the entire array runs in one transaction. */
  statements?: DatabaseStatement[];
  maxRows?: number;
  maxBytes?: number;
};

export type DatabaseValue = string | number | null
  | { type: "bigint"; value: string }
  | { type: "blob"; base64: string }
  | { type: "number"; value: "Infinity" | "-Infinity" | "NaN" };

export type DatabaseStatementResult = {
  /** Positional rows preserve duplicate column names. */
  columns: string[];
  rows: DatabaseValue[][];
  /** Decimal total_changes() delta, including trigger changes; SELECT/DDL normally report "0". */
  changes: string;
  rowsTruncated: false | "max_rows" | "max_bytes";
  columnsTruncated: boolean;
};

export type DatabaseExecution = {
  database: DatabaseName;
  atomic: boolean;
  statements: DatabaseStatement[];
  maxRows: number;
  maxBytes: number;
};
export type DatabaseExecutionResult = {
  database: DatabaseName;
  atomic: boolean;
  results: DatabaseStatementResult[];
  limits: { maxRows: number; maxBytes: number };
  truncated: boolean;
};
export type DatabaseResult = DatabaseExecutionResult | {
  databases: { name: DatabaseName; default: boolean }[];
};
