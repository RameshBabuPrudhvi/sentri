#!/usr/bin/env node
/**
 * @module database/migrations/scripts/backfill-routes
 * @description B2.1 — One-shot operator script: backfill
 *   `agent_configs.routeId` from the legacy `provider` + `model`
 *   columns by find-or-creating matching `provider_routes` rows.
 *
 * Run AFTER migration 037 (the `routeId` column) and BEFORE the
 * column-drop migration. Safe to re-run — rows where `routeId IS NOT
 * NULL` are skipped, and find-or-create dedupes by composite key
 * `(workspaceId, family, protocol, model, baseUrl)`.
 *
 * ## Usage
 *
 *   node backend/src/database/migrations/scripts/backfill-routes.js \
 *     [--dry-run] [--workspace=<id>]
 *
 *   --dry-run            Print every planned write but commit nothing.
 *   --workspace=<id>     Scope to one workspace (default: all).
 *
 * ## Why a .js script, not a .sql migration
 *
 * `migrationRunner.js` only executes `.sql` files. Backfill needs:
 *   • AES-256-GCM encryption of the workspace's existing plaintext
 *     API key into `provider_routes.{apiKeyEncrypted, apiKeyNonce,
 *     apiKeyLastFour}` (B1.4 contract).
 *   • Find-or-create by composite key with NULL-aware equality.
 *   • Per-provider lookup of `apiKeyRepo` / Ollama default base URL /
 *     compat-slot config for `baseUrl` + key resolution.
 *
 * None of that is expressible in pure SQL.
 *
 * ## Key inheritance model
 *
 * `apiKeyRepo` is **global per-deployment**, not per-workspace —
 * `apiKeyRepo.get("anthropic")` returns the single deployment-wide
 * key. Every workspace's backfilled route therefore inherits the
 * same encrypted blob, and the audit trail records the inheritance
 * so operators can rotate per-workspace post-migration. This keeps
 * the platform dispatch-usable the moment B2.6 removes the legacy
 * `resolveProvider` path — leaving routes keyless would silently
 * break every workspace on flag flip.
 *
 * When the global key is missing, the route is still created (so
 * dispatch can resolve it once an operator adds the key via
 * Settings), but `apiKeyEncrypted` stays NULL and the row is
 * counted in `skippedReasons.no_api_key`.
 */
import { randomUUID } from "crypto";
import { getDatabase } from "../../sqlite.js";
import * as apiKeyRepo from "../../repositories/apiKeyRepo.js";
import * as providerRouteAuditRepo from "../../repositories/providerRouteAuditRepo.js";
import * as secrets from "../../../aiProvider/secrets.js";
import { protocolForProvider, familyForProvider } from "../../../aiProvider/protocolForProvider.js";

const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
/**
 * Resolve `{ family, protocol, baseUrl, apiKey, model }` for the
 * route we would create from a single `agent_configs` row.
 *
 * Returns `{ _unmapped: true, ... }` when the provider isn't in the
 * shared protocol map. Never throws so one bad row can't fail the
 * whole run — caller logs + skips.
 *
 * @param {Object} cfg - The agent_configs row.
 * @returns {Object|null}
 */
export function resolveRouteShape(cfg) {
  const provider = String(cfg.provider || "").trim();
  if (!provider) return null;
  let family;
  let protocol;
  try {
    family = familyForProvider(provider);
    protocol = protocolForProvider(provider);
  } catch (err) {
    return { _unmapped: true, provider, error: err.message };
  }
  let model = cfg.model || null;
  let baseUrl = null;
  let apiKey = null;
  if (provider === "local") {
    // Ollama — no auth by default. Carry workspace-default baseUrl +
    // model when the agent_config didn't override. Fall back to
    // localhost so a workspace with no saved Ollama config still
    // gets a usable route.
    const ollama = apiKeyRepo.get("local");
    baseUrl = ollama?.baseUrl || OLLAMA_DEFAULT_BASE_URL;
    if (!model) model = ollama?.model || null;
  } else if (provider.startsWith("compat:")) {
    // Compat slot — baseUrl + apiKey + model all live in the slot config.
    const slot = apiKeyRepo.getCompatSlot(provider);
    if (slot) {
      baseUrl = slot.baseUrl || null;
      apiKey = slot.apiKey || null;
      if (!model) model = slot.model || null;
    }
  } else {
    // Cloud provider — apiKeyRepo stores the plaintext key globally.
    // baseUrl stays null (SDK-default endpoint).
    const stored = apiKeyRepo.get(provider);
    apiKey = typeof stored === "string" ? stored : null;
  }
  return { family, protocol, baseUrl, apiKey, model };
}
/**
 * Find an existing `provider_routes` row matching the composite key.
 *
 * The `NULL`-aware equality is required because SQLite `=` is never
 * true for `NULL`, so a bare `model = ?` with a null param would
 * never match a NULL row and we'd create a duplicate route for
 * every agent_config with no model. Same logic applies to
 * `baseUrl`.
 */
export function findExistingRoute(db, { workspaceId, family, protocol, model, baseUrl }) {
  return db.prepare(
    "SELECT id FROM provider_routes " +
    "WHERE workspaceId = ? AND family = ? AND protocol = ? " +
    "  AND ((model IS NULL AND ? IS NULL) OR model = ?) " +
    "  AND ((baseUrl IS NULL AND ? IS NULL) OR baseUrl = ?) " +
    "ORDER BY createdAt ASC LIMIT 1",
  ).get(workspaceId, family, protocol, model, model, baseUrl, baseUrl);
}
/**
 * Build a stable, collision-resistant `name` for a synthesised
 * route. `UNIQUE(workspaceId, name)` from migration 035 — append a
 * random suffix so a re-run after a rolled-back attempt can't
 * collide with its own previous synthetic name.
 */
function synthesiseRouteName(workspaceId, family) {
  const wsSuffix = String(workspaceId || "ws").slice(-6);
  const rand = randomUUID().slice(0, 6);
  return "migrated-" + family + "-" + wsSuffix + "-" + rand;
}

/**
 * Sentinel thrown at the tail of a --dry-run transaction so
 * better-sqlite3 rolls back all writes. A defined class lets the
 * surrounding try/catch distinguish dry-run rollback from a real
 * error without string matching.
 */
class DryRunRollback extends Error {
  constructor() { super("__dry_run_rollback__"); this.name = "DryRunRollback"; }
}
/**
 * Run the backfill. Exported for tests + the CLI entry point below.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false]    Roll back all writes at the end.
 * @param {string}  [opts.workspaceId]     Restrict to a single workspace.
 * @param {Function}[opts.log]             Optional logger; defaults to no-op.
 * @returns {Object} Summary stats.
 */
export function runBackfill({ dryRun = false, workspaceId = null, log = () => {} } = {}) {
  const db = getDatabase();
  const rows = workspaceId
    ? db.prepare(
        "SELECT id, workspaceId, provider, model, role FROM agent_configs " +
        "WHERE routeId IS NULL AND provider IS NOT NULL AND workspaceId = ?",
      ).all(workspaceId)
    : db.prepare(
        "SELECT id, workspaceId, provider, model, role FROM agent_configs " +
        "WHERE routeId IS NULL AND provider IS NOT NULL",
      ).all();

  const stats = {
    workspacesScanned: new Set(rows.map((r) => r.workspaceId)).size,
    rowsBackfilled: 0,
    routesCreated: 0,
    routesReused: 0,
    skipped: 0,
    skippedReasons: {},
    dryRun,
  };
  function recordSkip(reason) {
    stats.skipped += 1;
    stats.skippedReasons[reason] = (stats.skippedReasons[reason] || 0) + 1;
  }

  // Group by workspace so each workspace's writes run in its own
  // transaction — a mid-loop failure on one workspace doesn't half-
  // migrate it, and other workspaces keep progressing.
  const byWorkspace = new Map();
  for (const row of rows) {
    if (!byWorkspace.has(row.workspaceId)) byWorkspace.set(row.workspaceId, []);
    byWorkspace.get(row.workspaceId).push(row);
  }

  for (const [wsId, wsRows] of byWorkspace) {
    try {
      db.transaction(() => {
        for (const row of wsRows) {
          const shape = resolveRouteShape(row);
          if (!shape) { recordSkip("empty_provider"); continue; }
          if (shape._unmapped) {
            log("[backfill] skip unmapped provider \"" + shape.provider + "\" on row " + row.id + ": " + shape.error);
            recordSkip("unmapped_provider");
            continue;
          }
          // Composite-key find-or-create. Reused routes count toward
          // `routesReused`, not `routesCreated`, so a re-run can be
          // verified idempotent by asserting `routesCreated === 0`.
          let routeId;
          const existing = findExistingRoute(db, {
            workspaceId: row.workspaceId,
            family: shape.family,
            protocol: shape.protocol,
            model: shape.model,
            baseUrl: shape.baseUrl,
          });
          if (existing) {
            routeId = existing.id;
            stats.routesReused += 1;
          } else {
            routeId = "pr-" + randomUUID();
            const now = new Date().toISOString();
            const name = synthesiseRouteName(row.workspaceId, shape.family);
            // Encrypt the inherited global key (when present) so the
            // route is dispatch-ready post-migration. When no key is
            // available we still create the route with NULL secret
            // columns and tag the audit entry — the operator must
            // rotate via Settings before this route can dispatch.
            let apiKeyEncrypted = null;
            let apiKeyNonce = null;
            let apiKeyLastFour = null;
            if (shape.apiKey) {
              const enc = secrets.encryptKey(shape.apiKey);
              apiKeyEncrypted = enc.ciphertext;
              apiKeyNonce = enc.nonce;
              apiKeyLastFour = enc.lastFour;
            } else if (shape.family !== "local") {
              // Ollama is legitimately keyless; every other family
              // without a key needs operator action — count it so
              // the run summary surfaces the gap.
              recordSkip("no_api_key");
            }
            db.prepare(
              "INSERT INTO provider_routes (id, workspaceId, name, family, protocol, baseUrl, model, " +
              "apiKeyEncrypted, apiKeyNonce, apiKeyLastFour, enabled, cacheEnabled, cacheTtlSec, createdAt, updatedAt) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)",
            ).run(
              routeId, row.workspaceId, name, shape.family, shape.protocol, shape.baseUrl, shape.model,
              apiKeyEncrypted, apiKeyNonce, apiKeyLastFour, now, now,
            );
            providerRouteAuditRepo.append({
              workspaceId: row.workspaceId,
              routeId,
              userId: null,
              action: "create",
              metadata: {
                source: "backfill-routes",
                inheritedFromGlobalKey: Boolean(shape.apiKey),
                family: shape.family,
                protocol: shape.protocol,
                model: shape.model,
                fromAgentConfigId: row.id,
                fromAgentRole: row.role,
              },
            });
            stats.routesCreated += 1;
          }
          db.prepare(
            "UPDATE agent_configs SET routeId = ?, updatedAt = ? WHERE id = ?",
          ).run(routeId, new Date().toISOString(), row.id);
          stats.rowsBackfilled += 1;
        }
        if (dryRun) throw new DryRunRollback();
      })();
    } catch (err) {
      if (err instanceof DryRunRollback) {
        log("[backfill] workspace " + wsId + " — dry-run rollback (no writes committed)");
      } else {
        // Real error — log + continue to the next workspace so one
        // bad workspace can't block the rest of the deployment.
        log("[backfill] workspace " + wsId + " FAILED: " + err.message);
        recordSkip("workspace_tx_error");
      }
    }
  }
  return stats;
}
// ── CLI entry ────────────────────────────────────────────────────────────────
// Only run when executed directly (`node backfill-routes.js`). Tests
// import the module and call `runBackfill()` programmatically, so this
// guard prevents the CLI from firing during `import` in the test
// harness. Mirrors the `if (require.main === module)` CJS pattern.
import { fileURLToPath } from "url";
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const dryRun = process.argv.includes("--dry-run");
  const wsArg = process.argv.find((a) => a.startsWith("--workspace="));
  const workspaceId = wsArg ? wsArg.slice("--workspace=".length) : null;
  const stats = runBackfill({
    dryRun,
    workspaceId,
    log: (msg) => console.log(msg),
  });
  console.log(JSON.stringify(stats, null, 2));
}

