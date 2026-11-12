import { createExtensionRuntime, type ResourceLoader, type Skill } from "@earendil-works/pi-coding-agent";

/** 只接收技能目录服务选中的资源；不使用 SDK 的个人 CLI/父目录配置和扩展自动发现。 */
export const createResourceLoader = (
  systemPrompt: string,
  skills: Skill[] = [],
  extensionResult?: ReturnType<ResourceLoader["getExtensions"]>,
): ResourceLoader => ({
  getExtensions: () =>
    extensionResult
      ? {
          extensions: extensionResult.extensions,
          errors: extensionResult.errors,
          runtime: extensionResult.runtime,
        }
      : {
          extensions: [],
          errors: [],
          runtime: createExtensionRuntime(),
        },
  getSkills: () => ({ skills, diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => systemPrompt,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
});
