import type { InformationRepository } from "../../features/information/types.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import {
  claimSmsBatchSync,
  claimSmsItemsSync,
  completeSmsModelRoundSync,
  ensureSmsModule,
  failPendingSmsPublicationsSync,
  finalizeSmsDeliverySync,
  getSmsArchiveBriefingWaveSync,
  getSmsItemSync,
  getSmsNotificationContextSync,
  getSmsRunSync,
  getSmsStatusSummarySync,
  ingestSmsItemsSync,
  listSmsItemsSync,
  listSmsRunsSync,
  markSmsRunFailedSync,
  markSmsRunSplitSync,
  pruneSmsHistorySync,
  readNextRealtimeDue,
  readSmsSettingsSync,
  reconcileSmsOnStartSync,
  requeueFailedSmsSync,
  revertClaimedSmsRunSync,
  setSmsRunPublicationsSync,
  updateSmsPublicationSync,
  validateSmsStorageSync,
  writeSmsSettingsSync,
} from "./sms-schema.js";

/**
 * 短信/信息仓储（Clean Break v4）：直接面向 main.sqlite sms_* 表的精准 SQL 查询与原子事务，
 * 消除全表反序列化与内存副本重写。
 */
export const createInformationRepository = (managed: ManagedSqliteDatabase): InformationRepository => {
  let ensured = false;
  const ensureOnce = () => {
    if (ensured) return;
    ensureSmsModule(managed);
    ensured = true;
  };

  return {
    getSettings: () => managed.serialize(() => {
      ensureOnce();
      return readSmsSettingsSync(managed.database);
    }),
    saveSettings: (settings) => managed.serialize(() => {
      ensureOnce();
      return managed.transaction(() => writeSmsSettingsSync(managed.database, settings));
    }),
    ingestItems: (queue, inputs, now) => managed.serialize(() => {
      ensureOnce();
      return managed.transaction(() => ingestSmsItemsSync(managed.database, queue, inputs, now));
    }),
    listItems: (options) => managed.serialize(() => {
      ensureOnce();
      return listSmsItemsSync(managed.database, options);
    }),
    getItem: (itemId) => managed.serialize(() => {
      ensureOnce();
      return getSmsItemSync(managed.database, itemId);
    }),
    listRuns: (options) => managed.serialize(() => {
      ensureOnce();
      return listSmsRunsSync(managed.database, options);
    }),
    getRun: (runId) => managed.serialize(() => {
      ensureOnce();
      return getSmsRunSync(managed.database, runId);
    }),
    getStatusSummary: () => managed.serialize(() => {
      ensureOnce();
      return getSmsStatusSummarySync(managed.database);
    }),
    requeueFailed: (queue) => managed.serialize(() => {
      ensureOnce();
      return managed.transaction(() => requeueFailedSmsSync(managed.database, queue));
    }),
    claimBatch: (queue, options) => managed.serialize(() => {
      ensureOnce();
      return managed.transaction(() => claimSmsBatchSync(managed.database, queue, options));
    }),
    claimItems: (queue, itemIds, now) => managed.serialize(() => {
      ensureOnce();
      return managed.transaction(() => claimSmsItemsSync(managed.database, queue, itemIds, now));
    }),
    revertClaimedRun: (runId, itemIds, finishedAt) => managed.serialize(() => {
      ensureOnce();
      return managed.transaction(() => revertClaimedSmsRunSync(managed.database, runId, itemIds, finishedAt));
    }),
    markRunFailed: (runId, itemIds, errorMessage, finishedAt) => managed.serialize(() => {
      ensureOnce();
      return managed.transaction(() => markSmsRunFailedSync(managed.database, runId, itemIds, errorMessage, finishedAt));
    }),
    markRunSplit: (runId, itemIds, errorMessage, finishedAt) => managed.serialize(() => {
      ensureOnce();
      return managed.transaction(() => markSmsRunSplitSync(managed.database, runId, itemIds, errorMessage, finishedAt));
    }),
    completeModelRound: (input) => managed.serialize(() => {
      ensureOnce();
      return managed.transaction(() => completeSmsModelRoundSync(managed.database, input));
    }),
    updatePublication: (runId, notificationId, update) => managed.serialize(() => {
      ensureOnce();
      managed.transaction(() => updateSmsPublicationSync(managed.database, runId, notificationId, update));
    }),
    failPendingPublications: (runId, reason) => managed.serialize(() => {
      ensureOnce();
      managed.transaction(() => failPendingSmsPublicationsSync(managed.database, runId, reason));
    }),
    finalizeDelivery: (runId, finishedAt, interruptReason) => managed.serialize(() => {
      ensureOnce();
      return managed.transaction(() => finalizeSmsDeliverySync(managed.database, runId, finishedAt, interruptReason));
    }),
    setRunPublications: (runId, publications) => managed.serialize(() => {
      ensureOnce();
      managed.transaction(() => setSmsRunPublicationsSync(managed.database, runId, publications));
    }),
    getNotificationContext: (notificationId) => managed.serialize(() => {
      ensureOnce();
      return getSmsNotificationContextSync(managed.database, notificationId);
    }),
    getArchiveBriefingWave: () => managed.serialize(() => {
      ensureOnce();
      return getSmsArchiveBriefingWaveSync(managed.database);
    }),
    pruneHistory: (limits) => managed.serialize(() => {
      ensureOnce();
      return managed.transaction(() => pruneSmsHistorySync(managed.database, limits));
    }),
    validateAll: () => managed.serialize(() => {
      ensureOnce();
      validateSmsStorageSync(managed.database);
    }),
    nextRealtimeDue: () => managed.serialize(() => {
      ensureOnce();
      return readNextRealtimeDue(managed);
    }),
    reconcileOnStart: () => managed.serialize(() => {
      ensureOnce();
      managed.transaction(() => reconcileSmsOnStartSync(managed.database, new Date().toISOString()));
    }),
  };
};
