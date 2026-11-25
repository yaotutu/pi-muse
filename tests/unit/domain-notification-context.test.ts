import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationMessage, notificationSubagentIdOf } from "../../src/adapters/pi/notification-message.js";
import {
  SUBAGENTS_HEADING,
  buildSubagentsSystemPrompt,
} from "../../src/adapters/pi/domain-notification-context.js";

const runId = "inforun_01234567-89ab-cdef-0123-456789abcdef";

test("subagents prompt renders each subagent's own description and routingHint", () => {
  const prompt = buildSubagentsSystemPrompt([
    {
      id: "sms",
      name: "短信助手",
      description: "过滤手机短信并维护提醒规则",
      routingHint: "Never store SMS filtering preferences only in global memory.",
      parallelAllowed: true,
    },
    {
      id: "browser",
      name: "浏览器助手",
      description: "多步操作共享真实浏览器",
      parallelAllowed: false,
    },
  ]);
  assert.match(prompt, new RegExp(`## ${SUBAGENTS_HEADING}`));
  assert.match(prompt, /`sms` \(短信助手\): 过滤手机短信并维护提醒规则/);
  assert.match(prompt, /Routing note: Never store SMS filtering preferences only in global memory\./);
  assert.match(prompt, /`browser` \(浏览器助手\): 多步操作共享真实浏览器/);
  assert.doesNotMatch(prompt, /excluded from your conversation context/);
});

test("notificationSubagentIdOf extracts valid subagent tags and ignores invalid markers", () => {
  const smsNotification = createNotificationMessage({
    id: `info-notification-${runId}-0`,
    text: "快递取件码 1234",
    subagentId: "sms",
  });
  const generic = createNotificationMessage({ id: "server-notification-1", text: "monitor changed" });
  const badTag = createNotificationMessage({ id: "bad-tag-1", text: "bad", subagentId: "INVALID!" });
  const legacy = createNotificationMessage({ id: `info-notification-${runId}-1`, text: "旧短信提醒" });

  assert.equal(notificationSubagentIdOf(smsNotification), "sms");
  assert.equal(notificationSubagentIdOf(generic), undefined);
  assert.equal(notificationSubagentIdOf(badTag), undefined);
  assert.equal(notificationSubagentIdOf(legacy), "sms");
  assert.equal("personalBotSubagentId" in legacy, false);
});
