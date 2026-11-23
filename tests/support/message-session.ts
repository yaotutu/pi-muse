import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageFeedbackRepository } from "../../src/adapters/storage/message-feedback-repository.js";
import { messageFeedbackModule } from "../../src/adapters/storage/message-feedback-schema.js";
import { openSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { createMessageFeedbackSession, type MessageFeedbackSession } from "../../src/features/messages/service.js";
import type { MessageExecutionFact } from "../../src/features/messages/types.js";

/** 单元测试使用真实消息服务与 SQLite repository，只替换 PI facts 来源。 */
export const createMessageFeedbackFixture = async (input: {
  sessionId: string;
  piSessionId: string;
  facts: () => readonly MessageExecutionFact[];
}): Promise<{ messages: MessageFeedbackSession; cleanup: () => Promise<void> }> => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-message-unit-"));
  const managed = await openSqliteDatabase(join(root, "main.sqlite"));
  await managed.serialize(() => ensureSqliteModules(managed, [messageFeedbackModule]));
  const messages = createMessageFeedbackSession({
    sessionId: input.sessionId,
    piSessionId: () => input.piSessionId,
    facts: input.facts,
    repository: createMessageFeedbackRepository(managed),
  });
  return {
    messages,
    cleanup: async () => {
      try { await managed.close(); } finally { await rm(root, { recursive: true, force: true }); }
    },
  };
};
