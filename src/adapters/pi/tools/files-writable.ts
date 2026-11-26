import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { isWorkspaceText } from "../../../shared/workspace-text.js";
import { ASSISTANT_TEXT_LIMIT } from "../../../features/identity/types.js";
import { resolveWorkspacePath, safeWorkspacePath } from "./workspace-path.js";
import { managedWorkspaceTarget } from "../../workspace/managed-text.js";
import type { WorkspaceCommitQueue } from "../../workspace/file-commit-queue.js";
import {
  awaitFileApproval,
  commitApprovedFile,
  deniedResult,
  MAX_TEXT_FILE_BYTES,
  readFileSnapshot,
  type ApprovalActions,
  type ApprovalContext,
  type ApprovalObservation,
  type FileSnapshot,
  type RunApprovalObserver,
} from "./file-approval.js";

export type { RunApprovalObserver };

const aborted = () => deniedResult("Operation aborted; nothing was written.");

/** 新文件可缺失，已有祖先和根目录仍逐段拒绝链接；审批后用同一规则重查。 */
const safeTarget = async (root: string, path: string, boundaryDir?: string) => {
  if (!path.trim()) throw new Error("Unsafe path");
  const selected = resolveWorkspacePath(root, path);
  if (!selected || selected.path === selected.base) throw new Error("Unsafe path");
  const managed = managedWorkspaceTarget(boundaryDir ?? root, selected.path);
  if (managed !== undefined && selected.path !== managed) throw new Error("Use canonical managed path");
  return {
    target: await safeWorkspacePath(selected.base, selected.path, { allowMissing: true, boundaryDir }),
    managed: managed !== undefined,
  };
};

const validateText = (content: string, managed: boolean, subagentId?: string, allowManagedForSubagent?: boolean) => {
  if (managed && subagentId && !allowManagedForSubagent) return "Subagents cannot modify managed setting files.";
  if (managed && content.length > ASSISTANT_TEXT_LIMIT) return `Settings text exceeds ${ASSISTANT_TEXT_LIMIT} characters.`;
  if (!isWorkspaceText(content)) return "File content must be valid UTF-8 without NUL bytes.";
};

/** 每次 run 由组合方传入新的上下文；此工厂不推断当前 runId。 */
export const createWritableFileTools = (
  root: string,
  actions: ApprovalActions,
  timeoutMs: number,
  context?: ApprovalContext,
  boundaryDir?: string,
  observation?: RunApprovalObserver,
  commitQueue?: WorkspaceCommitQueue,
  options?: { allowManagedForSubagent?: boolean },
) => [
  defineTool({
    name: "write", label: "Write file",
    description: "Create or overwrite a text file inside the documents directory. Every write requires explicit user approval. Relative paths only, no symlinks or ..; max 100KB. Concurrent changes require new approval.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the documents directory." }),
      content: Type.String({ description: "Full file content to write." }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      if (signal?.aborted) return aborted();
      if (Buffer.byteLength(params.content, "utf8") > MAX_TEXT_FILE_BYTES)
        return deniedResult("File too large: writes are limited to 100KB.");
      let target: string;
      let managed: boolean;
      let original: FileSnapshot | undefined;
      try {
        ({ target, managed } = await safeTarget(root, params.path, boundaryDir));
        original = await readFileSnapshot(target);
      } catch {
        return deniedResult("Access denied: unsafe or unreadable file path.");
      }
      const content = params.content;
      const validationError = validateText(content, managed, context?.subagentId, options?.allowManagedForSubagent);
      if (validationError) return deniedResult(validationError);
      const approved = await awaitFileApproval(
        actions,
        "file_write",
        `写入 ${params.path}`,
        {
          path: params.path,
          content: params.content,
          originalContent: original?.content ?? "",
          baseVersion: original?.version ?? "missing",
          beforeExists: String(original !== undefined),
        },
        timeoutMs,
        signal,
        { ...context, toolCallId: _id },
        observation ? (event: ApprovalObservation) => observation.observe({
          ...event,
          id: `${observation.prefix}:${event.id}`,
          parentId: `${observation.prefix}:tool:${_id}`,
        }) : undefined,
      );
      if (!approved) return deniedResult("Write not approved (denied, expired or cancelled); nothing was written.");
      return commitApprovedFile({
        target,
        successPath: params.path,
        original,
        content: params.content,
        approval: approved,
        actions,
        signal,
        commitQueue,
        validateTarget: async (candidate) => (await safeTarget(root, params.path, boundaryDir)).target === candidate,
      });
    },
  }),
  defineTool({
    name: "edit", label: "Edit file",
    description: "Replace one exact nonempty text occurrence in an existing file. Requires explicit user approval; oldText must appear exactly once; resulting file max 100KB. Concurrent changes require new approval.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the documents directory." }),
      oldText: Type.String({ minLength: 1, description: "Nonempty exact existing text to replace." }),
      newText: Type.String({ description: "Replacement text." }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      if (signal?.aborted) return aborted();
      let target: string;
      let managed: boolean;
      let original: FileSnapshot | undefined;
      try {
        ({ target, managed } = await safeTarget(root, params.path, boundaryDir));
        original = await readFileSnapshot(target);
      } catch {
        return deniedResult("Access denied: unsafe or unreadable file path.");
      }
      if (!original) return deniedResult("File not found.");
      const first = original.content.indexOf(params.oldText);
      if (first < 0) return deniedResult("oldText not found in the file.");
      if (original.content.indexOf(params.oldText, first + 1) >= 0)
        return deniedResult("oldText appears more than once; make it unique first.");
      const content = original.content.slice(0, first) + params.newText + original.content.slice(first + params.oldText.length);
      if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE_BYTES)
        return deniedResult("File too large: edited files are limited to 100KB.");
      const validationError = validateText(content, managed, context?.subagentId, options?.allowManagedForSubagent);
      if (validationError) return deniedResult(validationError);
      const approved = await awaitFileApproval(
        actions,
        "file_edit",
        `编辑 ${params.path}`,
        {
          path: params.path,
          oldText: params.oldText,
          newText: params.newText,
          originalContent: original.content,
          content,
          baseVersion: original.version,
          beforeExists: "true",
        },
        timeoutMs,
        signal,
        { ...context, toolCallId: _id },
        observation ? (event: ApprovalObservation) => observation.observe({
          ...event,
          id: `${observation.prefix}:${event.id}`,
          parentId: `${observation.prefix}:tool:${_id}`,
        }) : undefined,
      );
      if (!approved) return deniedResult("Edit not approved (denied, expired or cancelled); nothing was written.");
      return commitApprovedFile({
        target,
        successPath: params.path,
        original,
        content,
        approval: approved,
        actions,
        signal,
        commitQueue,
        validateTarget: async (candidate) => (await safeTarget(root, params.path, boundaryDir)).target === candidate,
      });
    },
  }),
] as const;
