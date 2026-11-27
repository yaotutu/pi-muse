import type { SqliteModule } from "./sqlite-modules.js";
import { jobsModule } from "./jobs-schema.js";
import { goalsModule } from "./goals-schema.js";
import { actionsModule } from "./actions-schema.js";
import { smsModule } from "./sms-schema.js";
import { dreamModule } from "./dream-schema.js";
import { messageFeedbackModule } from "./message-feedback-schema.js";
import { habitsModule } from "./habits-schema.js";

/**
 * main.sqlite 的模块注册表。
 *
 * 顺序即建库顺序；账本按模块登记版本，因此新增模块不会影响已有模块的版本。
 */
export const mainSqliteModules: readonly SqliteModule[] = [
  jobsModule,
  goalsModule,
  actionsModule,
  smsModule,
  dreamModule,
  messageFeedbackModule,
  habitsModule,
];
