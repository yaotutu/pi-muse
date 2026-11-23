import { resolve } from "node:path";
import { ASSISTANT_TEXT_LIMIT } from "../../features/identity/types.js";

export const managedWorkspaceTexts = {
  user: "assistant/USER.md",
  soul: "assistant/SOUL.md",
  assistantInstructions: "assistant/INSTRUCTIONS.md",
  smsInstructions: "domains/sms/INSTRUCTIONS.md",
  newsInstructions: "domains/news/INSTRUCTIONS.md",
} as const;

export const managedWorkspaceTarget = (root: string, target: string) =>
  Object.values(managedWorkspaceTexts).map((path) => resolve(root, path))
    .find((path) => path.toLowerCase() === target.toLowerCase());

export const isManagedWorkspaceText = (root: string, target: string) =>
  managedWorkspaceTarget(root, target) !== undefined;

export const workspaceTextLimit = (root: string, target: string) =>
  isManagedWorkspaceText(root, target) ? ASSISTANT_TEXT_LIMIT : undefined;
