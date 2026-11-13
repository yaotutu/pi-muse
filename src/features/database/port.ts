import type { DatabaseExecution, DatabaseExecutionResult } from "./types.js";

export interface DatabaseToolStore {
  execute(request: DatabaseExecution, signal?: AbortSignal): Promise<DatabaseExecutionResult>;
}
