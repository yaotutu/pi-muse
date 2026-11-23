export type WorkspaceIncludeStatus =
  | "loaded"
  | "missing"
  | "invalid"
  | "cycle"
  | "depth_exceeded"
  | "truncated"
  | "empty";

export type WorkspaceIncludeDiagnostic = {
  path: string;
  resolvedPath?: string;
  status: WorkspaceIncludeStatus;
};

export type ResolvedWorkspaceDocument = {
  raw: string;
  resolved: string;
  includes: WorkspaceIncludeDiagnostic[];
  truncated: boolean;
};
