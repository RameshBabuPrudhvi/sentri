/**
 * @module database/repositories/notificationSettingsRepo
 * @description Per-project notification settings CRUD (FEA-001).
 *
 * Each project may have one notification configuration row that stores
 * channel URLs (Microsoft Teams webhook, generic webhook) and email
 * recipients.  When a test run completes with failures, the notification
 * dispatcher reads this configuration and fires all enabled channels.
 */

import { getDatabase } from "../sqlite.js";

/**
 * Get the notification settings for a project.
 *
 * @param {string} projectId
 * @returns {Object|undefined}
 */
export function getByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM notification_settings WHERE projectId = ?"
  ).get(projectId) || undefined;
}

/**
 * Create or update notification settings for a project.
 *
 * @param {Object} settings
 * @param {string} settings.id
 * @param {string} settings.projectId
 * @param {string} [settings.teamsWebhookUrl]
 * @param {string} [settings.emailRecipients]
 * @param {string} [settings.webhookUrl]
 * @param {boolean} [settings.enabled]
 * @param {string} settings.createdAt
 * @param {string} settings.updatedAt
 * @returns {Object} The upserted settings row.
 */
export function upsert(settings) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO notification_settings (id, projectId, teamsWebhookUrl, emailRecipients, webhookUrl, enabled, createdAt, updatedAt)
    VALUES (@id, @projectId, @teamsWebhookUrl, @emailRecipients, @webhookUrl, @enabled, @createdAt, @updatedAt)
    ON CONFLICT(projectId) DO UPDATE SET
      teamsWebhookUrl = @teamsWebhookUrl,
      emailRecipients = @emailRecipients,
      webhookUrl      = @webhookUrl,
      enabled         = @enabled,
      updatedAt       = @updatedAt
  `).run({
    id: settings.id,
    projectId: settings.projectId,
    teamsWebhookUrl: settings.teamsWebhookUrl || null,
    emailRecipients: settings.emailRecipients || null,
    webhookUrl: settings.webhookUrl || null,
    enabled: settings.enabled !== false ? 1 : 0,
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt,
  });
  return getByProjectId(settings.projectId);
}

/**
 * Delete notification settings for a project.
 *
 * @param {string} projectId
 * @returns {boolean} Whether a row was deleted.
 */
export function deleteByProjectId(projectId) {
  const db = getDatabase();
  const info = db.prepare(
    "DELETE FROM notification_settings WHERE projectId = ?"
  ).run(projectId);
  return info.changes > 0;
}
