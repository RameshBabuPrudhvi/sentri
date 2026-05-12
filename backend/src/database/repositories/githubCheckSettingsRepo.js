/**
 * @module database/repositories/githubCheckSettingsRepo
 * @description Per-project GitHub Check Run integration settings (INT-002).
 */

import { getDatabase } from "../sqlite.js";

function rowToSettings(row) {
  if (!row) return undefined;
  return { ...row, enabled: !!row.enabled };
}

/**
 * Get GitHub check settings for a project.
 *
 * @param {string} projectId
 * @returns {Object|undefined}
 */
export function getByProjectId(projectId) {
  const db = getDatabase();
  return rowToSettings(db.prepare("SELECT * FROM github_check_settings WHERE projectId = ?").get(projectId));
}

/**
 * Create or update GitHub check settings for a project.
 *
 * @param {Object} settings
 * @param {string} settings.projectId
 * @param {boolean} settings.enabled
 * @param {string|null} [settings.installationId]
 * @param {string|null} [settings.repo]
 * @param {string} settings.createdAt
 * @param {string} settings.updatedAt
 * @returns {Object|undefined}
 */
export function upsert(settings) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO github_check_settings (projectId, enabled, installationId, repo, createdAt, updatedAt)
    VALUES (@projectId, @enabled, @installationId, @repo, @createdAt, @updatedAt)
    ON CONFLICT(projectId) DO UPDATE SET
      enabled = @enabled,
      installationId = @installationId,
      repo = @repo,
      updatedAt = @updatedAt
  `).run({
    projectId: settings.projectId,
    enabled: settings.enabled ? 1 : 0,
    installationId: settings.installationId || null,
    repo: settings.repo || null,
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt,
  });
  return getByProjectId(settings.projectId);
}

/**
 * List GitHub check settings for project IDs.
 *
 * @param {string[]} projectIds
 * @returns {Object[]}
 */
export function listByProjectIds(projectIds) {
  if (!projectIds?.length) return [];
  const db = getDatabase();
  const placeholders = projectIds.map(() => "?").join(", ");
  return db.prepare(`SELECT * FROM github_check_settings WHERE projectId IN (${placeholders})`).all(...projectIds).map(rowToSettings);
}
