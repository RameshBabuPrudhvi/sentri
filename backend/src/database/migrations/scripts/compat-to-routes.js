#!/usr/bin/env node
/**
 * @module database/migrations/scripts/compat-to-routes
 * @description B3.10 — One-shot operator script: convert every legacy
 *   `compat:<slot>` config row in `api_keys` into a proper
 *   `provider_routes` row with `family: "custom"`, `protocol: "openai"`.
 *
 * Run AFTER B1.x migrations have applied (migration 035 `provider_routes`,
 * 036 `provider_route_audit`). Safe to re-run — the (workspaceId, name)
 * composite key dedupes; rows that already exist for this name in the
 * target workspace are skipped (counted in `skippedReasons.exists`).
 *
 * ## Usage
 *
 *   node backend/src/database/migrations/scripts/compat-to-routes.js \
 *     [--dry-run] [--workspace=<id>] [--delete-source]
 *
 *   --dry-run         Print every planned write but commit nothing.
 *   --workspace=<id>  Pin the new routes to a specific workspaceId. When
 *                     omitted, the script uses the workspace whose `id`
 *                     is the first non-system row in `workspaces` — this
 *                     matches the single-tenant default. Multi-tenant
 *                     deployments MUST pass `--workspace` because compat
 *                     slots are deployment-global today (no workspaceId
 *                     column on `api_keys`).
 *   --delete-source   After successful migration, drop the
 *                     `api_keys WHERE provider LIKE 'compat:%'` rows.
 *                     Off by default — operators can verify the new
 *                     routes work end-to-end before deleting the source.
 *
 * ## Why a .js script (not .sql)
 *
 * `migrationRunner.js` only executes `.sql` files. This migration needs:
 *   • AES-256-GCM re-encryption — the legacy `api_keys.value` uses
 *     `credentialEncryption.js` (scrypt-derived key, `enc:v1:` envelope);
 *     `provider_routes.apiKeyEncrypted` uses `aiProvider/secrets.js`
 *     (raw 32-byte master key from `SENTRI_MASTER_KEY`). The two
 *     encryption schemes are not interchangeable — the plaintext must
 *     be decrypted under the old scheme, then re-encrypted under the
 *     new.
 *   • Per-slot composite-key lookup against `provider_routes` to skip
 *     re-runs idempotently.
 *   • Audit-row emission tagged with the migration source so the
 *     forensic trail is preserved.
 *
 * Neither is expressible in pure SQL.
 *
 * ## Audit trail
 *
 * Every new route gets an `action: "create"` audit row with
 * `metadata: { source: "compat-to-routes", fromCompatSlot, model,
 * baseUrl }` so operators can later answer "which routes came from the
 * legacy compat config?". The `apiKeyLastFour` round-trips so the
 * Settings UI can show the masked tail without re-decrypting.
 */
import { randomUUID } from "crypto";
import { getDatabase } from "../../sqlite.js";
import * as apiKeyRepo from "../../repositories/apiKeyRepo.js";
import * as providerRouteAuditRepo from "../../repositories/providerRouteAuditRepo.js";
import * as secrets from "../../../aiProvider/secrets.js";

/**
 * Sentinel exception used to roll back the dry-run transaction without
 * conflating with a real error. Mirrors the pattern from
 * `backfill-routes.js`.
 */
class DryRunRollback extends Error {
  constructor() { super("__dry_run_rollback__"); this.name = "DryRunRollback"; }
}

/**
 * Find a target workspace when `--workspace` was not provided. Returns
 * the first non-`__system__` row's id. Multi-tenant deployments MUST
 * pass an explicit workspaceId — the auto-pick is a single-tenant
 * convenience that fails closed by returning null when zero non-system
 * workspaces exist.
 */
function autoPickWorkspace(db) {
  const rows = db.prepare(
    "SELECT id FROM workspaces WHERE id != '__system__' ORDER BY createdAt ASC",
  ).all();
  if (rows.length === 1) return rows[0].id;
  return null;
}

/**
 * Execute the migration. Exported for tests + the CLI entry below.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false]      Roll back all writes at the end.
 * @param {string}  [opts.workspaceId]       Pin the new routes to this workspace.
 * @param {boolean} [opts.deleteSource=false] Drop legacy `api_keys` rows after migrating.
 * @param {Function}[opts.log]               Optional logger; defaults to no-op.
 * @returns {Object} Summary stats.
 */
export function runMigration({ dryRun = false, workspaceId = null, deleteSource = false, log = () => {} } = {}) {
  const db = getDatabase();
  const targetWorkspace = workspaceId || autoPickWorkspace(db);
  if (!targetWorkspace) {
    return {
      error: "No target workspace. Multi-tenant deployments MUST pass --workspace=<id>; single-tenant deployments need at least one non-system workspace row.",
      created: 0, skipped: 0, deletedSource: 0,
    };
  }

  const slots = apiKeyRepo.listCompatSlots();
  const stats = {
    workspaceId: targetWorkspace,
    slotsScanned: slots.length,
    created: 0,
    skipped: 0,
    deletedSource: 0,
    skippedReasons: {},
    dryRun,
  };
  function recordSkip(reason) {
    stats.skipped += 1;
    stats.skippedReasons[reason] = (stats.skippedReasons[reason] || 0) + 1;
  }

  try {
    db.transaction(() => {
      for (const compatProvider of slots) {
        const slotId = compatProvider.slice("compat:".length);
        const cfg = apiKeyRepo.getCompatSlot(compatProvider);
        if (!cfg || !cfg.apiKey || !cfg.baseUrl || !cfg.model) {
          log("[compat-to-routes] skip incomplete slot: " + compatProvider);
          recordSkip("incomplete_config");
          continue;
        }
        // Derive a route name from the compat slot's slotId. Operators
        // can rename via Settings later; this just ensures the migrated
        // rows are immediately recognisable in the Settings UI list.
        const routeName = "compat-" + slotId;
        const existing = db.prepare(
          "SELECT id FROM provider_routes WHERE workspaceId = ? AND name = ?",
        ).get(targetWorkspace, routeName);
        if (existing) {
          log("[compat-to-routes] skip already-migrated slot: " + compatProvider);
          recordSkip("exists");
          continue;
        }
        // Re-encrypt the plaintext apiKey under the B1.4 secrets module.
        // `apiKeyRepo.getCompatSlot` already returned plaintext (it
        // decrypted the legacy `api_keys.value` blob under the old
        // `credentialEncryption.js` scheme).
        const enc = secrets.encryptKey(cfg.apiKey);
        const routeId = "pr-" + randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO provider_routes (id, workspaceId, name, family, protocol, baseUrl, model, " +
          "apiKeyEncrypted, apiKeyNonce, apiKeyLastFour, enabled, cacheEnabled, cacheTtlSec, createdAt, updatedAt) " +
          "VALUES (?, ?, ?, 'custom', 'openai', ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)",
        ).run(
          routeId, targetWorkspace, routeName,
          cfg.baseUrl, cfg.model,
          enc.ciphertext, enc.nonce, enc.lastFour,
          now, now,
        );
        providerRouteAuditRepo.append({
          workspaceId: targetWorkspace,
          routeId,
          userId: null,
          action: "create",
          metadata: {
            source: "compat-to-routes",
            fromCompatSlot: compatProvider,
            slotId,
            displayName: cfg.displayName || slotId,
            model: cfg.model,
            baseUrl: cfg.baseUrl,
            // Mirrors the per-route `lastFour` so operators can match
            // the migrated route to the original key out-of-band.
            lastFour: enc.lastFour,
          },
        });
        stats.created += 1;
        // Optionally delete the legacy api_keys row after successful
        // migration. Off by default so operators can verify dispatch
        // works end-to-end before dropping the source.
        if (deleteSource) {
          apiKeyRepo.deleteCompatSlot(compatProvider);
          stats.deletedSource += 1;
        }
        log("[compat-to-routes] migrated " + compatProvider + " -> " + routeName + " (" + routeId + ")");
      }
      if (dryRun) throw new DryRunRollback();
    })();
  } catch (err) {
    if (err instanceof DryRunRollback) {
      log("[compat-to-routes] dry-run rollback — no writes committed");
    } else {
      log("[compat-to-routes] FAILED: " + err.message);
      stats.error = err.message;
    }
  }
  return stats;
}

// ── CLI entry ────────────────────────────────────────────────────────────────
// Only run when executed directly. Tests import the module and call
// `runMigration()` programmatically, so this guard prevents the CLI
// from firing during `import` in the test harness.
import { fileURLToPath } from "url";
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const dryRun = process.argv.includes("--dry-run");
  const deleteSource = process.argv.includes("--delete-source");
  const wsArg = process.argv.find((a) => a.startsWith("--workspace="));
  const workspaceId = wsArg ? wsArg.slice("--workspace=".length) : null;
  const stats = runMigration({
    dryRun,
    deleteSource,
    workspaceId,
    log: (msg) => console.log(msg),
  });
  console.log(JSON.stringify(stats, null, 2));
}
