import { z } from "zod";

export const workspaceIncludeStatusSchema = z.enum([
  "loaded",
  "missing",
  "invalid",
  "cycle",
  "depth_exceeded",
  "truncated",
  "empty",
]);

export const workspaceIncludeDiagnosticSchema = z.strictObject({
  path: z.string().min(1).describe("文档顶部 frontmatter include 中填写的原始引用路径"),
  resolvedPath: z.string().min(1).optional().describe("工作区内规范化后的相对路径（越界或非法路径省略）"),
  status: workspaceIncludeStatusSchema.describe("loaded=已注入；missing=文件不存在；invalid=非法/越界/符号链接/非纯文本；cycle=重复或循环引用；depth_exceeded=超过最大嵌套深度；truncated=超出字符预算；empty=内容为空"),
});
