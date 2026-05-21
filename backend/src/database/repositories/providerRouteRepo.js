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
 * @param {Object} input
 * @param {string} [input.id]
 * @param {string} input.workspaceId
 * @param {string} [input.userId]    — Audit actor; null for system writes.
 * @returns {Object} The freshly persisted row (re-read via getById).
 * @throws {Error & { code: "ERR_ROUTE_FALLBACK_CYCLE" }}
 * @throws {Error & { code: "ERR_ROUTE_MISSING_FIELD" }}
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
  const tx = db.transaction(() => {
    if (!existing) {
      // ── INSERT ────────────────────────────────────────────────────────────
       
      const missing = REQUIRED_INSERT_FIELDS.filter((f) => !input[f]);
      if (missing.length) {
        const err = new Error(`Missing required field(s): ${missing.join(", ")}`);
        err.code = "ERR_ROUTE_MISSING_FIELD";
        throw err;
      }
      const cols = ["id", "workspaceId", ...MUTABLE_FIELDS, "createdAt", "updatedAt"];
      const placeholders = cols.map(() => "?").join(", ");
      const values = cols.map((c) => {
        if (c === "id") return targetId;
        if (c === "workspaceId") return workspaceId;
        if (c === "createdAt" || c === "updatedAt") return now;
        const wire = toWireValue(c, input[c]);
        return wire === undefined ? null : wire;
      });
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
    } else {
      // ── UPDATE (partial-patch) ────────────────────────────────────────────
      const changed = diffFields(existing, input);
      if (changed.length === 0) {
        // No-op write — skip audit and return existing. Matches the
        // agentConfigRepo.upsert contract: idempotent saves don't pollute
        // the audit log with phantom "update" events.
        return;
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
    auditRepo.append({
      workspaceId, routeId: id, userId,
      action: "delete",
      metadata: { name: existing.name, family: existing.family },
    });
    return { deleted: deleted.changes, fallbacksCleared: cleared.changes };
  });
  return tx();
}
