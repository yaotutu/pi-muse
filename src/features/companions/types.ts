export const COMPANION_STATES = ["idle", "thinking", "responding", "working", "waiting-approval", "success", "error", "stopped"] as const;
export type CompanionState = typeof COMPANION_STATES[number];
export const COMPANION_PACK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const isCompanionPackId = (value: unknown): value is string => typeof value === "string" && COMPANION_PACK_ID_PATTERN.test(value);
export const MAX_COMPANION_PNG_BYTES = 786_432;
export type CompanionMetadata = { name: string; description: string };
export type CompanionPackSummary = CompanionMetadata & { id: string; states: CompanionState[]; version: string; updatedAt: string };
export type CompanionDiagnostic = { id: string; message: string };
export type CompanionSnapshot = CompanionMetadata & { id: string; assets: Partial<Record<CompanionState, Uint8Array>>; updatedAt: string };

export class CompanionError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 400 | 404 | 409 | 413) { super(message); }
}

/** 端口只交付经过路径、文件和持久化结构校验的快照；单一服务队列覆盖完整读写。 */
export type CompanionStore = {
  list(): Promise<{ packs: CompanionSnapshot[]; diagnostics: CompanionDiagnostic[] }>;
  read(id: string): Promise<CompanionSnapshot | null>;
  writeMetadata(id: string, metadata: CompanionMetadata): Promise<void>;
  writeAsset(id: string, state: CompanionState, bytes: Uint8Array): Promise<void>;
  remove(id: string): Promise<boolean>;
};
