/**
 * @module database/repositories/providerRouteRepo
 * @description B1.3 — Data-access layer for the `provider_routes` table.
 *
 * Invariants enforced by this repo (dispatch relies on all three):
 *   1. `fallbackRouteId` chains never cycle — checked at upsert with a
 *      bounded walk lifted from `agentConfigRepo.wouldCreateCycle` (AI-005).
 *      Throws `ERR_ROUTE_FALLBACK_CYCLE`.
 *   2. JSON columns (`capabilities`, `pricing`) are serialised on write
 *      and parsed on read so callers see typed objects, not strings.
 *   3. Every mutation appends a `providerRouteAuditRepo` entry inside the
 *      same `db.transaction()` as the write — a failed audit rolls back
 *      the user's mutation.
 *
 * ## Secret handling
 *
 * `apiKeyEncrypted` / `apiKeyNonce` are stored as BLOBs (B1.4 owns the
 * AES-256-GCM helpers). This repo treats them as opaque bytes — never
 * logged, never round-tripped through audit metadata, and never returned
 * by the default SELECT. Use `getSecretById` to explicitly opt into
 * reading the secret blob.
 */
import { randomUUID } from "crypto";
import { getDatabase } from "../sqlite.js";
import * as auditRepo from "./providerRouteAuditRepo.js";
// B1.4 — invalidate the plaintext cache when an apiKey is rotated or the
// row is deleted. The cycle (`secrets.js` imports this repo for
// `getSecretById`; this repo imports `secrets.js` for cache invalidation)
// is safe under Node ESM: neither module calls an imported function at
// top-level, so both finish initialisation before any cache method runs.
import * as secrets from "../../aiProvider/secrets.js";
// B2.2 — capability probe wiring. Same import-cycle reasoning as
// `secrets.js` above: the probe module imports protocol adapters which
// import secrets which import this repo, but no top-level call walks
// the cycle so initialisation completes cleanly.
import { runCapabilityProbe } from "../../aiProvider/capabilityProbe.js";
const SECRET_COLUMNS = Object.freeze(["apiKeyEncrypted", "apiKeyNonce"]);
const SAFE_COLUMNS = [
  "id", "workspaceId", "name", "family", "protocol", "baseUrl", "model",
  "apiKeyLastFour",
  "capabilities", "pricing",
  "rpmLimit", "tpmLimit",
  "cacheEnabled", "cacheTtlSec",
  "fallbackRouteId", "enabled",
  "createdAt", "updatedAt",
];
const SAFE_SELECT = SAFE_COLUMNS.join(", ");
const MUTABLE_FIELDS = Object.freeze([
  "name", "family", "protocol", "baseUrl", "model",
  "apiKeyEncrypted", "apiKeyNonce", "apiKeyLastFour",
  "capabilities", "pricing",
  "rpmLimit", "tpmLimit",
  "cacheEnabled", "cacheTtlSec",
  "fallbackRouteId", "enabled",
]);
const REQUIRED_INSERT_FIELDS = Object.freeze(["name", "family", "protocol", "model"]);
// ── JSON helpers ──────────────────────────────────────────────────────────────
function parseJsonOrNull(value) {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}
function stringifyJson(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
function hydrate(row) {
  if (!row) return row;
  return {
    ...row,
    capabilities: parseJsonOrNull(row.capabilities),
    pricing: parseJsonOrNull(row.pricing),
  };
}
// ── Reads ─────────────────────────────────────────────────────────────────────
/**
 * List every route in a workspace, ordered by name. Secret blobs omitted.
 * @param {string} workspaceId
 * @returns {Object[]}
 */
export function list(workspaceId) {
  return getDatabase().prepare(
    `SELECT ${SAFE_SELECT} FROM provider_routes WHERE workspaceId = ? ORDER BY name ASC`
  ).all(workspaceId).map(hydrate);
}
/**
 * Fetch one route by id, workspace-scoped. Returns `undefined` when the
 * id belongs to a different workspace — callers must NOT leak the
 * existence of cross-workspace routes.
 */
export function getById(workspaceId, id) {
  return hydrate(getDatabase().prepare(
    `SELECT ${SAFE_SELECT} FROM provider_routes WHERE id = ? AND workspaceId = ?`
  ).get(id, workspaceId));
}
/**
 * Fetch one route by its human name, workspace-scoped.
 * `UNIQUE(workspaceId, name)` makes this single-row.
 */
export function getByName(workspaceId, name) {
  return hydrate(getDatabase().prepare(
    `SELECT ${SAFE_SELECT} FROM provider_routes WHERE workspaceId = ? AND name = ?`
  ).get(workspaceId, name));
}
/**
 * List routes filtered by provider `family` (anthropic / openai / google /
 * ollama / custom). Drives dispatch-side family enumeration.
 */
export function listByFamily(workspaceId, family) {
  return getDatabase().prepare(
    `SELECT ${SAFE_SELECT} FROM provider_routes WHERE workspaceId = ? AND family = ? ORDER BY name ASC`
  ).all(workspaceId, family).map(hydrate);
}
/**
 * Fetch encrypted secret material for a single route. Dedicated helper so
 * dispatch (B2+) explicitly opts into reading the secret blob; never
 * called from list/render paths.
 */
export function getSecretById(workspaceId, id) {
  return getDatabase().prepare(
    `SELECT ${SECRET_COLUMNS.join(", ")}, apiKeyLastFour FROM provider_routes WHERE id = ? AND workspaceId = ?`
  ).get(id, workspaceId);
}
// ── Cycle detection ───────────────────────────────────────────────────────────
/**
 * Walk the `fallbackRouteId` chain starting from `startRouteId` (with its
 * fallback hypothetically set to `proposedFallbackId`) and return `true`
 * if the walk revisits `startRouteId`. Pattern from
 * `agentConfigRepo.wouldCreateCycle` (AI-005), id-keyed.
 */
function wouldCreateCycle(workspaceId, startRouteId, proposedFallbackId) {
  if (!proposedFallbackId) return false;
  if (proposedFallbackId === startRouteId) return true;
  const db = getDatabase();
  const seen = new Set([startRouteId]);
  let next = proposedFallbackId;
  // Bounded — caps the check at 64 indexed lookups; any legitimate
  // fallback graph is far shorter than this.
  for (let i = 0; i < 64 && next; i += 1) {
    if (seen.has(next)) return true;
    seen.add(next);
    const row = db.prepare(
      "SELECT fallbackRouteId FROM provider_routes WHERE id = ? AND workspaceId = ?"
    ).get(next, workspaceId);
    next = row?.fallbackRouteId || null;
  }
  return false;
}
// ── Writes ────────────────────────────────────────────────────────────────────
/**
 * Buffer + JSON aware equality. Used by `diffFields` so identical
 * encrypted blobs don't false-positive as `rotate_key`, and structurally-
 * identical JSON objects don't generate spurious `changed` entries.
 */
function valuesEqual(a, b, field) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return Buffer.compare(a, b) === 0;
  if (field === "capabilities" || field === "pricing") {
    return stringifyJson(a) === stringifyJson(b);
  }
  if (field === "enabled" || field === "cacheEnabled") {
    return (a ? 1 : 0) === (b ? 1 : 0);
  }
  return false;
}
function diffFields(existing, patch) {
  const changed = [];
  for (const f of MUTABLE_FIELDS) {
    if (!(f in patch)) continue;
    if (!valuesEqual(existing?.[f], patch[f], f)) changed.push(f);
  }
  return changed;
}
function toWireValue(field, value) {
  if (value === undefined) return undefined;
  if (field === "capabilities" || field === "pricing") return stringifyJson(value);
  if (field === "enabled" || field === "cacheEnabled") return value ? 1 : 0;
  return value;
}
/**
 * Insert a new route, or update an existing one identified by `input.id`
 * (preferred) or `(workspaceId, input.name)`. Update semantics are
 * partial-patch: any `MUTABLE_FIELDS` value left `undefined` keeps its
 * existing column value; explicit `null` clears it.
 *
 * Emits an audit row in the same transaction:
 *   • insert → action="create", metadata={ name, family, protocol, model }
 *   • update touching apiKeyEncrypted → action="rotate_key",
 *     metadata={ lastFour }   (never cleartext or ciphertext)
 *   • other update → action="update", metadata={ changed: [<field>…] }
 *
 * ## B2.2 — Auto-probe-on-upsert
 *
 * After the transaction commits, schedules a fire-and-forget capability
 * probe (`probeAndPersist`) via `setImmediate` when:
 *   • The route is new (insert), OR
 *   • Any **routing-relevant** field changed: `apiKeyEncrypted`,
 *     `apiKeyNonce`, `model`, `baseUrl`, `family`, `protocol`.
 *
 * Pricing-only / quota-only / cache-only / name-only updates DON'T
 * trigger a re-probe because the network result wouldn't change.
 *
 * The probe runs OUTSIDE the transaction — never blocks the upsert's
 * synchronous return, never holds a SQLite write lock during the 10s
 * network call. Capabilities land asynchronously on the row; clients
 * polling the row see `null → {probed result}` within a few seconds.
 *
 * Opt out via `input.skipAutoProbe: true` — used by:
 *   • The backfill script (inherited global keys may not work in every
 *     workspace; operators expected to rotate before relying on probe).
 *   • The manual `probeAndPersist` endpoint when it calls upsert
 *     internally (would otherwise probe twice).
 *
 * Errors in the deferred probe are swallowed (best-effort) — the route
 * stays persisted with `capabilities: null` and the operator can hit
 * the manual probe button via the Settings UI to retry.
 *
 * @param {Object} input
 * @param {string} [input.id]
 * @param {string} input.workspaceId
 * @param {string} [input.userId]    — Audit actor; null for system writes.
 * @param {boolean} [input.skipAutoProbe] — When true, suppress B2.2 auto-probe.
 * @returns {Object} The freshly persisted row (re-read via getById).
 * @throws {Error} An Error with `code === "ERR_ROUTE_FALLBACK_CYCLE"`.
 * @throws {Error} An Error with `code === "ERR_ROUTE_MISSING_FIELD"`.
 */
export function upsert(input) {
  if (!input?.workspaceId) {
    const err = new Error("workspaceId is required");
    err.code = "ERR_ROUTE_MISSING_FIELD";
    throw err;
  }
  const db = getDatabase();
  const { workspaceId, userId } = input;
  // Resolve the target row (if any) BEFORE the transaction so we can
  // decide insert vs update without holding a write lock across the lookup.
  // We need the secret columns too so `diffFields` can detect rotation.
  let existingSafe = input.id ? getById(workspaceId, input.id) : null;
  if (!existingSafe && input.name) existingSafe = getByName(workspaceId, input.name);
  const existingSecret = existingSafe ? getSecretById(workspaceId, existingSafe.id) : null;
  const existing = existingSafe ? { ...existingSafe, ...existingSecret } : null;
  const targetId = existing?.id || input.id || `pr-${randomUUID()}`;
  if ("fallbackRouteId" in input
      && wouldCreateCycle(workspaceId, targetId, input.fallbackRouteId)) {
    const err = new Error(
      `fallbackRouteId cycle detected: ${targetId} → ${input.fallbackRouteId}`
    );
    err.code = "ERR_ROUTE_FALLBACK_CYCLE";
    throw err;
  }
  const now = new Date().toISOString();
  // B2.2 — fields whose change invalidates the prior probe result.
  // Pricing / quotas / cache / name changes leave dispatch reachability
  // unchanged, so we don't burn a probe on them. Apikey changes
  // (rotation) DO invalidate the probe because the new key might not
  // work — same row, different result.
  const PROBE_RELEVANT_FIELDS = ["apiKeyEncrypted", "apiKeyNonce", "model", "baseUrl", "family", "protocol"];
  let shouldAutoProbe = false;
  const tx = db.transaction(() => {
    if (!existing) {
      // ── INSERT ────────────────────────────────────────────────────────────
       
      const missing = REQUIRED_INSERT_FIELDS.filter((f) => !input[f]);
      if (missing.length) {
        const err = new Error(`Missing required field(s): ${missing.join(", ")}`);
        err.code = "ERR_ROUTE_MISSING_FIELD";
        throw err;
      }
      // Build INSERT dynamically: omit MUTABLE_FIELDS columns the caller
      // left undefined so the SQL DEFAULT applies. This matters for the
      // NOT NULL columns (`enabled`, `cacheEnabled`, `cacheTtlSec`) whose
      // schema defaults would otherwise be clobbered by an explicit NULL
      // and trip the NOT NULL constraint.
      const cols = ["id", "workspaceId"];
      const values = [targetId, workspaceId];
      for (const f of MUTABLE_FIELDS) {
        const wire = toWireValue(f, input[f]);
        if (wire === undefined) continue;
        cols.push(f);
        values.push(wire);
      }
      cols.push("createdAt", "updatedAt");
      values.push(now, now);
      const placeholders = cols.map(() => "?").join(", ");
      db.prepare(
        `INSERT INTO provider_routes (${cols.join(", ")}) VALUES (${placeholders})`
      ).run(...values);
      auditRepo.append({
        workspaceId, routeId: targetId, userId,
        action: "create",
        metadata: {
          name: input.name, family: input.family,
          protocol: input.protocol, model: input.model,
        },
      });
      // New route → always probe (any of family / protocol / model
      // / baseUrl / apiKey could be wrong; the operator needs the
      // network-evidence badge to know).
      shouldAutoProbe = true;
    } else {
      // ── UPDATE (partial-patch) ────────────────────────────────────────────
      const changed = diffFields(existing, input);
      if (changed.length === 0) {
        // No-op write — skip audit and return existing. Matches the
        // agentConfigRepo.upsert contract: idempotent saves don't pollute
        // the audit log with phantom "update" events.
        return;
      }
      // B2.2 — re-probe only when something probe-relevant changed.
      // A rename or pricing-only update leaves dispatch reachability
      // unchanged; skipping the probe there saves a network call per
      // edit (matters at scale when admins iterate on cache TTL /
      // pricing without rotating keys).
      if (changed.some((f) => PROBE_RELEVANT_FIELDS.includes(f))) {
        shouldAutoProbe = true;
      }
      const setClauses = changed.map((c) => `${c} = ?`).concat("updatedAt = ?");
      const setValues = changed.map((c) => {
        const wire = toWireValue(c, input[c]);
        return wire === undefined ? null : wire;
      }).concat(now);
      db.prepare(
        `UPDATE provider_routes SET ${setClauses.join(", ")} WHERE id = ? AND workspaceId = ?`
      ).run(...setValues, existing.id, workspaceId);
      // Action upgrade: any change to apiKeyEncrypted is a key rotation,
      // logged with the NEW lastFour only — never the cleartext or
      // ciphertext. The audit row stays redacted even if the caller
      // sloppily passed extra fields in `input`.
      if (changed.includes("apiKeyEncrypted")) {
        auditRepo.append({
          workspaceId, routeId: existing.id, userId,
          action: "rotate_key",
          metadata: { lastFour: input.apiKeyLastFour ?? null },
        });
        // B1.4 — drop the cached plaintext so the next adapter call
        // re-decrypts the freshly-rotated ciphertext. Inside the tx so a
        // rolled-back rotate doesn't leave dispatch using a stale key
        // (the cache is a soft optimisation — a redundant invalidation
        // after rollback is harmless, the next call re-decrypts from
        // the unchanged blob).
        secrets.invalidateRouteSecret(existing.id);
      } else {
        auditRepo.append({
          workspaceId, routeId: existing.id, userId,
          action: "update",
          metadata: { changed },
        });
      }
    }
  });
  tx();
  // B2.2 — Auto-probe-on-upsert. Fire-and-forget so the upsert's
  // synchronous return contract is preserved. `setImmediate` schedules
  // the probe on the next event-loop tick — by then the tx is committed
  // and the row is visible to other queries (including the probe's own
  // `getById` lookup).
  //
  // We deliberately don't await the probe here even though we COULD —
  // upsert is sync from a better-sqlite3 perspective, and making it
  // async would force every call site (settings routes, tests, the
  // backfill script) to flip to `await`. Fire-and-forget keeps the
  // contract intact AND lets the probe run while the HTTP response
  // is already on its way back to the operator.
  //
  // Skipped when:
  //   • `input.skipAutoProbe === true` (backfill, manual-probe path)
  //   • No probe-relevant field changed (renames, pricing edits)
  //   • `tx()` returned early on no-op write (caught by !shouldAutoProbe)
  //
  // Errors swallowed — the row stays with `capabilities: null` and the
  // operator can hit the manual probe button in the Settings UI.
  if (shouldAutoProbe && !input.skipAutoProbe) {
    setImmediate(() => {
      probeAndPersist(workspaceId, targetId, { userId: userId || null }).catch(() => {
        // Best-effort: probe failures don't propagate. The route is
        // already persisted; the UI shows `capabilities: null` until
        // the operator retries via the manual probe endpoint.
      });
    });
  }
  return getById(workspaceId, targetId);
}
/**
 * Delete a route and null out any sibling `fallbackRouteId` references to
 * the deleted row in the same workspace. The two writes run in a single
 * transaction so dispatch can rely on the invariant that every non-null
 * `fallbackRouteId` points at an existing row. Mirrors the same pattern
 * in `agentConfigRepo.remove`.
 *
 * Emits a single audit row with action="delete" inside the transaction.
 * The ON DELETE SET NULL FK from the migration would handle the sibling
 * cleanup at the SQL level, but doing it explicitly here lets us record
 * a single audit row and gives us defined behaviour on PostgreSQL where
 * the FK semantics may differ from SQLite.
 *
 * @param {string} workspaceId
 * @param {string} id
 * @param {Object} [opts]
 * @param {string} [opts.userId]   — Audit actor.
 * @returns {{ deleted: number, fallbacksCleared: number }} better-sqlite3 changes counts.
 */
/**
 * B2.2 — Run a real network capability probe against an existing
 * route and persist the result to `provider_routes.capabilities`.
 *
 * Two-phase write so a flaky probe can't leave the row half-updated:
 *   1. `runCapabilityProbe(route)` returns a `capabilities` payload
 *      OUTSIDE the transaction. The probe itself does network I/O
 *      and can take seconds — holding a SQLite write lock that long
 *      would serialise the rest of the deployment.
 *   2. The transaction is opened only AFTER the probe resolves, then
 *      writes the JSON column + appends the audit row atomically.
 *
 * Audit entry is `action: "probe"` with `metadata: { capabilities }`
 * — never the secret. Lifeguard-flagged: the older endpoint at
 * `routes/settings.js` was a catalog copy with `action: "probe"`,
 * which is misleading. Once the route uses this helper, every
 * `action: "probe"` audit row reflects a real network confirmation.
 *
 * @param {string} workspaceId
 * @param {string} routeId
 * @param {Object} [opts]
 * @param {string} [opts.userId] - Audit actor; null for system probes.
 * @param {number} [opts.timeoutMs=10000]
 * @returns {Promise<Object|null>} The freshly persisted route row, or
 *   `null` when the routeId doesn't exist in this workspace (caller
 *   should 404).
 */
export async function probeAndPersist(workspaceId, routeId, { userId = null, timeoutMs } = {}) {
  const route = getById(workspaceId, routeId);
  if (!route) return null;
  // Probe runs OUTSIDE the transaction — see JSDoc.
  const capabilities = await runCapabilityProbe(route, { timeoutMs });
  const db = getDatabase();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE provider_routes SET capabilities = ?, updatedAt = ? WHERE id = ? AND workspaceId = ?",
    ).run(stringifyJson(capabilities), now, routeId, workspaceId);
    auditRepo.append({
      workspaceId,
      routeId,
      userId,
      action: "probe",
      metadata: {
        capabilities,
        // Surface probe outcome at the top level of metadata too so
        // audit-log filters (B3.9) can `WHERE metadata LIKE '%"reachable":false%'`
        // without parsing the nested `capabilities` JSON.
        reachable: capabilities.reachable,
        source: capabilities.source,
        errorReason: capabilities.errorReason || null,
      },
    });
  });
  tx();
  return getById(workspaceId, routeId);
}

export function remove(workspaceId, id, { userId } = {}) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const existing = getById(workspaceId, id);
    if (!existing) return { deleted: 0, fallbacksCleared: 0 };
    const cleared = db.prepare(
      "UPDATE provider_routes SET fallbackRouteId = NULL, updatedAt = ? " +
      "WHERE workspaceId = ? AND fallbackRouteId = ?"
    ).run(new Date().toISOString(), workspaceId, id);
    const deleted = db.prepare(
      "DELETE FROM provider_routes WHERE id = ? AND workspaceId = ?"
    ).run(id, workspaceId);
    // Concurrent-delete guard. Even though better-sqlite3 serialises writes,
    // two `remove()` calls can both pass the `getById` check above before
    // either of their DELETEs runs — the second one's DELETE would then
    // affect zero rows, but the unconditional audit append below would
    // still write a duplicate "delete" row. Gate the audit on
    // `deleted.changes > 0` so only the real deleter audits. The cache
    // invalidation is intentionally NOT gated: it's idempotent and dropping
    // the cache entry on a tombstoned route is harmless.
    if (deleted.changes > 0) {
      auditRepo.append({
        workspaceId, routeId: id, userId,
        action: "delete",
        metadata: { name: existing.name, family: existing.family },
      });
    }
    // B1.4 — drop the cached plaintext for the deleted route so a stale
    // dispatch call that races the delete doesn't continue using a
    // tombstoned key for up to 5 minutes after the row is gone.
    secrets.invalidateRouteSecret(id);
    return { deleted: deleted.changes, fallbacksCleared: cleared.changes };
  });
  return tx();
}
