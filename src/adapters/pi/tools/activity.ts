import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { ActivityError, type ActivityOverview, type ActivityRun } from "../../../features/activities/types.js";
import { loadPrompt } from "../../prompts/loader.js";

/** 供主 Agent registry 引用的稳定工具名，避免装配处散落字符串。 */
export const ACTIVITY_TOOL_NAME = "activity";

/** 从统一提示词目录加载活动工具说明书；语义边界与校验由服务端强约束。 */
export const ACTIVITY_TOOL_INSTRUCTIONS = loadPrompt("assistant/tools/activity.md");

const TITLE_MAX_LENGTH = 160;
const TEXT_MAX_LENGTH = 2000;

/** 成功与受控拒绝共用的 details 形状；显式声明避免 defineTool 从首个分支收窄类型。 */
type ActivityToolDetails = { denied: true } | { activity: ActivityOverview; completionPending?: true };

/** 受控拒绝保留可读原因；details.denied 让 pi 层知道该文案允许进入模型上下文。 */
const rejected = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: { denied: true } satisfies ActivityToolDetails,
  isError: true as const,
});

/**
 * 去掉首尾空白并拒绝纯空白：模型经常用空字符串占位未使用的可选参数，
 * 这些占位绝不能传给 ActivityRun 造成“空写”。
 */
const requiredText = (value: string | undefined) => {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text : undefined;
};

const tooLong = (text: string, maxLength: number) => text.length > maxLength;

const success = (activity: ActivityOverview, completionPending = false) => {
  const payload: ActivityToolDetails = completionPending
    ? { activity, completionPending: true }
    : { activity };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  };
};

/**
 * 活动工具：主 Agent 用 start/resume/update/wait/complete 驱动 ActivityRun。
 * ActivityError 是业务侧受控拒绝，可原样返回；其他异常继续抛出，
 * 由 pi 执行层统一脱敏，避免内部错误或敏感信息进入模型上下文与 JSONL。
 */
export const createActivityTool = (run: ActivityRun) =>
  defineTool({
    name: ACTIVITY_TOOL_NAME,
    label: "Work activity",
    description: ACTIVITY_TOOL_INSTRUCTIONS,
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("start"),
          Type.Literal("resume"),
          Type.Literal("update"),
          Type.Literal("wait"),
          Type.Literal("complete"),
        ]),
        title: Type.Optional(
          Type.String({ description: "Required for start: short activity title (max 160 characters)." }),
        ),
        goal: Type.Optional(
          Type.String({ description: "Required for start: the outcome to achieve (max 2000 characters)." }),
        ),
        deliverable: Type.Optional(
          Type.String({ description: "Required for start: what the user will receive (max 2000 characters)." }),
        ),
        activityId: Type.Optional(
          Type.String({ description: "Required for resume: id returned when the activity was started." }),
        ),
        progress: Type.Optional(
          Type.String({
            description: "Required for update (meaningful progress) and wait (the question for the user), max 2000 characters.",
          }),
        ),
        result: Type.Optional(
          Type.String({ description: "Required for complete: summary of the delivered outcome (max 2000 characters)." }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params): Promise<AgentToolResult<ActivityToolDetails>> => {
      try {
        if (params.action === "start") {
          const title = requiredText(params.title);
          if (!title) return rejected("start requires a non-blank title (max 160 characters).");
          if (tooLong(title, TITLE_MAX_LENGTH))
            return rejected(`title must be at most ${TITLE_MAX_LENGTH} characters.`);
          const goal = requiredText(params.goal);
          if (!goal) return rejected("start requires a non-blank goal (max 2000 characters).");
          if (tooLong(goal, TEXT_MAX_LENGTH))
            return rejected(`goal must be at most ${TEXT_MAX_LENGTH} characters.`);
          const deliverable = requiredText(params.deliverable);
          if (!deliverable)
            return rejected("start requires a non-blank deliverable (max 2000 characters).");
          if (tooLong(deliverable, TEXT_MAX_LENGTH))
            return rejected(`deliverable must be at most ${TEXT_MAX_LENGTH} characters.`);
          return success(run.start({ title, goal, deliverable }));
        }

        if (params.action === "resume") {
          const activityId = requiredText(params.activityId);
          if (!activityId)
            return rejected("resume requires a non-blank activityId from the activity being continued.");
          return success(run.resume(activityId));
        }

        if (params.action === "update") {
          const progress = requiredText(params.progress);
          if (!progress) return rejected("update requires non-blank progress (max 2000 characters).");
          if (tooLong(progress, TEXT_MAX_LENGTH))
            return rejected(`progress must be at most ${TEXT_MAX_LENGTH} characters.`);
          return success(run.update(progress));
        }

        if (params.action === "wait") {
          const question = requiredText(params.progress);
          if (!question) return rejected("wait requires a non-blank question in progress (max 2000 characters).");
          if (tooLong(question, TEXT_MAX_LENGTH))
            return rejected(`progress must be at most ${TEXT_MAX_LENGTH} characters.`);
          return success(run.wait(question));
        }

        if (params.action === "complete") {
          const result = requiredText(params.result);
          if (!result) return rejected("complete requires a non-blank result (max 2000 characters).");
          if (tooLong(result, TEXT_MAX_LENGTH))
            return rejected(`result must be at most ${TEXT_MAX_LENGTH} characters.`);
          // 只声明“等待最终 run 成功交付”，不是立即完成。
          return success(run.complete(result), true);
        }

        // schema 正常会拦截未知 action；直接调用工具时仍需给出受控错误。
        return rejected("Unknown activity action. Use start, resume, update, wait or complete.");
      } catch (error) {
        if (error instanceof ActivityError) return rejected(error.message);
        throw error;
      }
    },
  });
