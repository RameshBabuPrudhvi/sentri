/**
 * @module database/repositories/githubCheckSettingsRepo
 * @description Per-project GitHub Check Run integration settings (INT-002).
 *
 * ### installationId encryption (INT-002b follow-up)
 *
 * `installationId` is stored AES-256-GCM encrypted at rest via
 * `encryptString` / `decryptString` from `utils/credentialEncryption.js`.
 * The encryption format is version-prefixed (`enc:v1:…`), so legacy
 * plaintext rows decrypt transparently — no backfill migration required;
 * rows re-encrypt naturally on the next `upsert()` call.
 *
 * **Cost trade-off, documented because it's surprising:** installation-keyed
 * lookups (`getByInstallationId`, `disableByInstallationId`, `disableByRepo`)
 * can no longer use SQL `WHERE installationId = ?` against a deterministic
 * column value — AES-GCM uses a fresh random IV per encryption, so the
 * ciphertext for the same plaintext differs every write. These methods now
 * load every row, decrypt `installationId`, and JS-filter. This is O(n) over
 * the number of projects with GitHub check settings configured (one row per
 * project), which is small enough in practice that the indexed-lookup loss
 * is acceptable. If row count ever grows past ~10k, revisit with a
 * deterministic HMAC-based lookup column (`installationIdHash`) so the
 * encrypted blob stays randomised but lookups stay O(1).
 *
 * **Threat-model honesty:** GitHub exposes `installationId` publicly in its
 * own UI and in every webhook payload. The encryption here is compliance
 * hardening for SOC 2 / ISO 27001 "encrypt all third-party identifiers at
 * rest" line items, not load-bearing security. The actual auth secret is
 * `GITHUB_APP_PRIVATE_KEY` (env var, never in DB). See ROADMAP.md
 * § INT-002b for the full rationale and the reversal of the prior WONTFIX.
 */

import { getDatabase } from "../sqlite.js";
import { encryptString, decryptString } from "../../utils/credentialEncryption.js";

function rowToSettings(row) {
  if (!row) return undefined;
  return { ...row, enabled: !!row.enabled, installationId: decryptString(row.installationId) };
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
    // Encrypt at rest. encryptString() returns null for empty input and a
    // randomised "enc:v1:…" blob otherwise — see module-level note above
    // for why this trades indexed lookups for compliance hardening.
    installationId: encryptString(settings.installationId),
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

/**
 * Get all GitHub check settings rows for an installation.
 *
 * **Lookup cost:** loads every row and JS-filters by decrypted
 * `installationId`. AES-GCM ciphertext is non-deterministic (fresh IV per
 * encryption) so a `WHERE installationId = ?` SQL filter against the
 * ciphertext column would never match. See the module-level doc comment
 * for the full rationale and the deterministic-HMAC escape hatch.
 *
 * @param {string|number} installationId
 * @returns {Object[]}
 */
export function getByInstallationId(installationId) {
  if (!installationId) return [];
  const db = getDatabase();
  const target = String(installationId);
  return db.prepare("SELECT * FROM github_check_settings").all()
    .map(rowToSettings)
    .filter((row) => row && row.installationId === target);
}

/**
 * Disable every GitHub check settings row for an installation.
 *
 * Same O(n) load-and-filter pattern as {@link getByInstallationId} — the
 * encrypted `installationId` column can't be used as a SQL predicate.
 *
 * @param {string|number} installationId
 * @returns {string[]} Project IDs that were disabled.
 */
export function disableByInstallationId(installationId) {
  if (!installationId) return [];
  const target = String(installationId);
  const matches = getByInstallationId(target).filter((row) => row.enabled);
  if (!matches.length) return [];
  const db = getDatabase();
  const now = new Date().toISOString();
  const update = db.prepare("UPDATE github_check_settings SET enabled = 0, updatedAt = ? WHERE projectId = ?");
  for (const row of matches) update.run(now, row.projectId);
  return matches.map((row) => row.projectId);
}

/**
 * Disable GitHub check settings for one repository within an installation.
 *
 * @param {string|number} installationId
 * @param {string} repo
 * @returns {string[]} Project IDs that were disabled.
 */
export function disableByRepo(installationId, repo) {
  if (!installationId || !repo) return [];
  const matches = getByInstallationId(installationId).filter((row) => row.enabled && row.repo === repo);
  if (!matches.length) return [];
  const db = getDatabase();
  const now = new Date().toISOString();
  const update = db.prepare("UPDATE github_check_settings SET enabled = 0, updatedAt = ? WHERE projectId = ?");
  for (const row of matches) update.run(now, row.projectId);
  return matches.map((row) => row.projectId);
}
