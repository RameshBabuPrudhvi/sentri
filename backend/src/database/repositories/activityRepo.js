/**
 * @module database/repositories/activityRepo
 * @description Activity log CRUD backed by SQLite.
 */

import crypto from "node:crypto";
import { getDatabase } from "../sqlite.js";

/**
 * SEC-007: Canonical hash-input shape for an activity row — everything that
 * is persisted EXCEPT `prevHash` itself. Both the INSERT path and the
 * verification path must use this identical helper so the computed hash
 * round-trips deterministically. Key order is stable because object
 * literal property order is preserved in V8.
 *
 * `meta` is normalised to its JSON-string form (or null) so the hash input
 * matches the exact byte sequence stored in the TEXT column — the
 * verification path reads the column back as TEXT and must hash it without
 * re-parsing.
 *
 * Note on `id`: the primary key is included in the hashed payload deliberately
 * so any re-numbering of activity rows (counter compaction, partial-backup
 * restore, manual edit) is detected by `verifyAuditChain` as tampering. The
 * tradeoff is that legitimate ID migrations require regenerating the chain
 * from scratch; we accept that cost because in a SOC 2 / PCI-DSS audit log
 * "the IDs changed but the content is the same" is exactly the class of
 * change a verifier should flag.
 *
 * @param {Object} row
 * @returns {Object}
 * @private
 */
function rowMinusHash(row) {
  return {
    id: row.id,
    type: row.type,
    projectId: row.projectId || null,
    projectName: row.projectName || null,
    testId: row.testId || null,
    testName: row.testName || null,
    detail: row.detail || null,
    status: row.status || "completed",
    createdAt: row.createdAt,
    userId: row.userId || null,
    userName: row.userName || null,
    workspaceId: row.workspaceId || null,
    meta: row.meta == null
      ? null
      : (typeof row.meta === "string" ? row.meta : JSON.stringify(row.meta)),
    ipAddress: row.ipAddress || null,
    userAgent: row.userAgent || null,
  };
}

/**
 * SEC-007: Compute the next `prevHash` from the previous row's hash and the
 * current row's content. Exported for tests and re-used by `verifyAuditChain`
 * so a single implementation is the source of truth (any drift between
 * INSERT and verify breaks the chain immediately rather than silently).
 *
 *   prevHash_i = sha256(prevHash_{i-1} ++ JSON.stringify(rowMinusHash_i))
 *
 * The leading hash for the very first row is the empty string.
 *
 * @param {string|null} previousHash
 * @param {Object}      row
 * @returns {string} 64-char lowercase hex digest.
 */
export function computePrevHash(previousHash, row) {
  const input = (previousHash || "") + JSON.stringify(rowMinusHash(row));
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * SEC-007: activity types eligible for compliance dedup.
 *
 * Industry-standard audit logs (Splunk, AWS CloudTrail, Auth0, Datadog)
 * collapse high-volume *system-emitted* events (read access, polling)
 * into a single row with a `count` + `lastAt`. They do NOT collapse
 * user-initiated state-change events because each one is an independent
 * attributable action.
 *
 * The allowlist captures exactly the event types where collapse is a
 * noise-reduction win, not an attribution loss:
 *
 * - `audit.read` / `audit.export` — page reloads + stats fetches emit
 *   bursts of identical reads. PCI-DSS 10.5.3 permits summarisation
 *   provided every event remains attributable; `count` + `lastAt`
 *   preserve attribution.
 * - `auth.login.failed` — credential-stuffing probes against a single
 *   account look like a burst of identical events. Collapsing makes the
 *   pattern MORE visible to a SOC 2 reviewer (one row "200 attempts"
 *   beats 200 noise rows).
 *
 * Every other event type (`auth.login`, `auth.role.change`, `test.*`,
 * `audit.purge`) is excluded — those are single user actions that must
 * each show as their own row for forensic reconstruction.
 *
 * @private
 */
const DEDUP_ELIGIBLE_TYPES = new Set([
  "audit.read",
  "audit.export",
  "auth.login.failed",
]);

/**
 * SEC-007: compute the dedup signature for an activity row.
 *
 * Two rows collapse only when this signature matches exactly — workspace,
 * actor, event type, AND meta-filter shape. Different filter shapes on
 * `audit.read` (e.g. one filtered by `dateFrom`, another with no filter)
 * stay as separate rows; they're semantically different audit access
 * patterns and a SOC 2 reviewer needs to see them as distinct events.
 *
 * `rowCount` is INTENTIONALLY excluded from the signature so two reads
 * with the same filter shape but different counts (a new audit row
 * appeared between reads) still collapse — the collapsed row's
 * `meta.rowCount` reflects the most recent read's count.
 *
 * @param {Object} row
 * @returns {string}
 * @private
 */
function dedupSignature(row) {
  const meta = row.meta || {};
  const sigMeta = {
    format: meta.format ?? null,
    filters: meta.filters
      ? {
          userId: meta.filters.userId ?? null,
          projectId: meta.filters.projectId ?? null,
          types: Array.isArray(meta.filters.types) ? [...meta.filters.types].sort() : null,
          dateFrom: meta.filters.dateFrom ?? null,
          dateTo: meta.filters.dateTo ?? null,
          ipAddress: meta.filters.ipAddress ?? null,
        }
      : null,
  };
  return JSON.stringify({
    workspaceId: row.workspaceId || null,
    userId: row.userId || null,
    type: row.type,
    meta: sigMeta,
  });
}

/**
 * SEC-007: dedup window in ms. Default 60s matches Auth0 / Datadog
 * industry-standard collapse window. `AUDIT_DEDUP_WINDOW_SEC=0` disables.
 * Read at call time so test `setupEnv()` flips it correctly.
 *
 * @returns {number}
 * @private
 */
function dedupWindowMs() {
  const raw = process.env.AUDIT_DEDUP_WINDOW_SEC;
  if (raw === "0") return 0;
  const sec = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000;
}

/**
 * Create an activity entry.
 *
 * ### Dedup (SEC-007)
 * For high-volume read-shaped events (`audit.read`, `audit.export`,
 * `auth.login.failed`), consecutive identical events within the dedup
 * window collapse into a single row with `count++` and `lastAt = now`.
 * Matches Splunk / CloudTrail / Auth0 industry practice — every event
 * is still counted (anti-exfiltration signals intact) but the feed
 * isn't dominated by duplicate noise. PCI-DSS 10.5.3 permits this
 * provided attribution is preserved. Window is `AUDIT_DEDUP_WINDOW_SEC`
 * (default 60, `0` disables).
 *
 * Dedup is automatically DISABLED when `AUDIT_HASH_CHAIN=true` —
 * mutating `lastAt`/`count` on a persisted row would invalidate its
 * `prevHash` and break the verification walk. With chain on, every
 * event is its own row (the chain is the higher-priority compliance
 * signal).
 *
 * When `AUDIT_HASH_CHAIN=true`, computes `prevHash` from the last row in
 * the same workspace and stores it in the same transaction as the INSERT.
 * Otherwise `prevHash` is persisted as null (chain disabled — default).
 *
 * @param {Object} activity — { id, type, projectId, projectName, testId, testName, detail, status, createdAt, userId?, userName?, workspaceId?, meta?, ipAddress?, userAgent?, prevHash? }
 */
export function create(activity) {
  const db = getDatabase();
  // `meta` is JSON-encoded TEXT (migration 018) so callers can pass a plain
  // object; readers below re-parse it. Null when absent so the column is
  // genuinely empty rather than the string "null".
  const metaStr = activity.meta != null ? JSON.stringify(activity.meta) : null;

  const insert = db.prepare(`
    INSERT INTO activities (id, type, projectId, projectName, testId, testName, detail, status, createdAt, userId, userName, workspaceId, meta, ipAddress, userAgent, prevHash)
    VALUES (@id, @type, @projectId, @projectName, @testId, @testName, @detail, @status, @createdAt, @userId, @userName, @workspaceId, @meta, @ipAddress, @userAgent, @prevHash)
  `);

  // SEC-007: hash-chain compute. Wrapped in a transaction so the lookup of
  // the previous row and the INSERT are atomic — without this, two parallel
  // logActivity() calls could both read the same "previous" row and chain
  // off it, producing two siblings with identical prevHash that break the
  // verification walk. The feature is opt-in (chained writes serialise
  // INSERTs under contention) and gated by AUDIT_HASH_CHAIN=true.
  const chainEnabled = process.env.AUDIT_HASH_CHAIN === "true";

  const params = {
    id: activity.id,
    type: activity.type,
    projectId: activity.projectId || null,
    projectName: activity.projectName || null,
    testId: activity.testId || null,
    testName: activity.testName || null,
    detail: activity.detail || null,
    status: activity.status || "completed",
    createdAt: activity.createdAt,
    userId: activity.userId || null,
    userName: activity.userName || null,
    workspaceId: activity.workspaceId || null,
    meta: metaStr,
    ipAddress: activity.ipAddress || null,
    userAgent: activity.userAgent || null,
    prevHash: activity.prevHash || null,
  };

  if (chainEnabled) {
    // Hash-chain path takes precedence over dedup. See the docstring above
    // for why these features are mutually exclusive at the row level.
    const tx = db.transaction((row) => {
      // Order by createdAt DESC then numerically by the trailing integer of
      // the `ACT-N` id (see idGenerator.js) as a tiebreaker for sub-
      // millisecond bursts. A plain `id DESC` would sort lexicographically
      // (ACT-10 < ACT-2), so at every digit boundary (9→10, 99→100, …) the
      // INSERT side would chain off ACT-9 while the verify-side ASC walk
      // visits ACT-10 right after ACT-1 — producing a spurious chain break.
      const prev = db.prepare(
        "SELECT prevHash FROM activities WHERE workspaceId = ? ORDER BY createdAt DESC, CAST(SUBSTR(id, 5) AS INTEGER) DESC LIMIT 1"
      ).get(row.workspaceId);
      // Pass the stringified meta (matching what's about to be persisted) so
      // computePrevHash's normaliser sees the same bytes the verifier will.
      row.prevHash = computePrevHash(prev?.prevHash || null, { ...row, meta: metaStr });
      insert.run(row);
    });
    tx(params);
    // SEC-007: mirror the computed prevHash back onto the caller's object so
    // downstream consumers (notably the SIEM forwarder in `activityLogger`)
    // dispatch the row with the same `prevHash` that's persisted in SQLite.
    // Without this mutation, every SIEM-forwarded event carries `prevHash: null`
    // and a SIEM-side integrity verifier can never reconstruct the chain.
    activity.prevHash = params.prevHash;
    return;
  }

  // SEC-007 dedup path. Try to fold this event into the most-recent
  // matching row within the dedup window before falling back to INSERT.
  // Wrapped in a transaction so the SELECT-then-UPDATE-or-INSERT race is
  // closed — two parallel logActivity calls cannot both INSERT siblings
  // because the UPDATE arm acquires the row lock first.
  const windowMs = dedupWindowMs();
  const eligible = windowMs > 0 && DEDUP_ELIGIBLE_TYPES.has(activity.type);
  if (!eligible) {
    insert.run(params);
    return;
  }

  const sig = dedupSignature({ ...activity, meta: activity.meta });
  // Hash the sig so the LIKE match works reliably — the raw JSON sig
  // contains quotes that get backslash-escaped inside the outer JSON
  // meta column, breaking substring matching. A hex hash is safe for
  // LIKE and deterministic.
  const sigHash = crypto.createHash("sha256").update(sig).digest("hex");
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  // `_dedupSig` flows in `meta._dedupSig` so the existing TEXT column carries
  // it without a schema change — but we strip it from the user-facing meta
  // in `hydrate()` below so consumers never see the internal field.
  const metaWithSig = activity.meta != null
    ? JSON.stringify({ ...activity.meta, _dedupSig: sigHash })
    : JSON.stringify({ _dedupSig: sigHash });
  params.meta = metaWithSig;

  const dedupTx = db.transaction(() => {
    // Look for a recent matching row. Cast to lexicographic-safe comparison
    // on ISO timestamps so the window is portable across SQLite + Postgres.
    // Match on the full _dedupSig substring inside meta — same portable
    // LIKE pattern used by `countDistinctTestIds.metaIsAutoApproved` above.
    const recent = db.prepare(`
      SELECT id, count, createdAt
      FROM activities
      WHERE type = ?
        AND (userId = ? OR (userId IS NULL AND ? IS NULL))
        AND (workspaceId = ? OR (workspaceId IS NULL AND ? IS NULL))
        AND createdAt >= ?
        AND meta LIKE ?
      ORDER BY createdAt DESC, CAST(SUBSTR(id, 5) AS INTEGER) DESC
      LIMIT 1
    `).get(
      activity.type,
      activity.userId || null, activity.userId || null,
      activity.workspaceId || null, activity.workspaceId || null,
      cutoff,
      `%${sigHash}%`,
    );

    if (recent) {
      // Update the existing row: bump count + lastAt, refresh meta to the
      // new event's full payload (so the rendered `rowCount`, `ipAddress`,
      // etc. always reflect the most recent event in the collapse).
      db.prepare(`
        UPDATE activities
        SET count = count + 1,
            lastAt = ?,
            meta = ?,
            ipAddress = ?,
            userAgent = ?
        WHERE id = ?
      `).run(activity.createdAt, metaWithSig, params.ipAddress, params.userAgent, recent.id);
      // Mutate the caller's activity so the SIEM forwarder sees the merged
      // row (same pattern as the prevHash mirror-back above).
      activity.id = recent.id;
      activity.count = (recent.count || 1) + 1;
      activity.lastAt = activity.createdAt;
      activity.createdAt = recent.createdAt;
      activity.deduped = true;
      return;
    }

    // No match in window — fresh row.
    insert.run(params);
    activity.count = 1;
    activity.lastAt = null;
    activity.deduped = false;
  });
  dedupTx();
}

/**
 * Re-parse the JSON `meta` column into a plain object for callers. Tolerant
 * of legacy rows where the column is null/empty/non-JSON — those rows
 * predate migration 018 and surface as `meta: null`.
 * @param {Object} row
 * @returns {Object}
 */
function hydrate(row) {
  if (!row) return row;
  if (typeof row.meta === "string" && row.meta.length > 0) {
    try { row.meta = JSON.parse(row.meta); } catch { row.meta = null; }
  } else if (row.meta === undefined) {
    row.meta = null;
  }
  // SEC-007: `_dedupSig` is a write-time-only internal field used by the
  // dedup matcher in `create()`. Strip it from the user-facing payload so
  // the UI, CSV/NDJSON exports, and SIEM forwarder never see it — only the
  // dedup matcher reads it (and only via raw LIKE on the TEXT column).
  if (row.meta && typeof row.meta === "object" && "_dedupSig" in row.meta) {
    const { _dedupSig: _omit, ...rest } = row.meta;
    void _omit;
    row.meta = Object.keys(rest).length > 0 ? rest : null;
  }
  return row;
}

/**
 * Get all activities.
 * @returns {Object[]}
 */
export function getAll() {
  const db = getDatabase();
  return db.prepare("SELECT * FROM activities ORDER BY createdAt DESC").all().map(hydrate);
}

/**
 * Get all activities as a dictionary keyed by ID.
 * @returns {Object<string, Object>}
 */
export function getAllAsDict() {
  const all = getAll();
  const dict = {};
  for (const a of all) dict[a.id] = a;
  return dict;
}

/**
 * Get filtered activities.
 *
 * `after` / `before` accept ISO-8601 strings (matching the column's storage
 * format). The comparison is lexicographic on ISO strings, which is correct
 * for the YYYY-MM-DDTHH:MM:SS.sssZ shape `Date.toISOString()` produces.
 *
 * `offset` pairs with `limit` for cursor-style "Load more" — clients pass
 * the count of rows they've already rendered. Combined with the default
 * `ORDER BY createdAt DESC`, this gives a stable forward window even
 * when new rows arrive between fetches (the ordering key is the row's
 * own timestamp, so a new row only shifts the cursor on the *first*
 * page, not subsequent pages).
 *
 * @param {Object} [filters]
 * @param {string} [filters.type]
 * @param {string} [filters.projectId]
 * @param {string} [filters.workspaceId] — Scope to workspace (ACL-001).
 * @param {string} [filters.after]       — ISO timestamp; only rows with
 *   `createdAt >= after` are returned. Powers the AUTO-003b approvals
 *   timeline date-range picker (This week / Last 30 days / Custom).
 * @param {string} [filters.before]      — ISO timestamp; only rows with
 *   `createdAt < before` are returned. Pairs with `after` for bounded
 *   ranges; either bound is optional.
 * @param {number} [filters.limit=200]
 * @param {number} [filters.offset]      — Skip the first N rows of the
 *   result set; used by paginated UIs (Load more) to fetch the next page.
 * @returns {Object[]}
 */
export function getFiltered({ type, projectId, testId, workspaceId, after, before, limit, offset } = {}) {
  const db = getDatabase();
  let sql = "SELECT * FROM activities WHERE 1=1";
  const params = [];
  if (workspaceId) {
    sql += " AND workspaceId = ?";
    params.push(workspaceId);
  }
  if (type) {
    sql += " AND type = ?";
    params.push(type);
  }
  if (projectId) {
    sql += " AND projectId = ?";
    params.push(projectId);
  }
  // ENT-004 (audit) — per-entity scoping so TestDetail can link directly
  // to its own activity slice (`/audit-log?testId=…`). Indexed via the
  // (workspaceId, testId) covering pattern used by the existing
  // workspace-scoped queries; for older deployments without the dedicated
  // index, the workspace+createdAt path narrows the row set enough that a
  // tail SELECT on `testId` stays bounded.
  if (testId) {
    sql += " AND testId = ?";
    params.push(testId);
  }
  if (after) {
    sql += " AND createdAt >= ?";
    params.push(after);
  }
  if (before) {
    sql += " AND createdAt < ?";
    params.push(before);
  }
  sql += " ORDER BY createdAt DESC LIMIT ?";
  // Honour an explicit `limit: 0` (legit "count-only / probe" value) and
  // reject non-finite inputs (NaN, Infinity) by falling back to the default
  // only for `undefined` / `null`. `limit || 200` would coerce both `0` and
  // `NaN` to 200 — the first silently returns 200 rows when the caller
  // asked for none; the second hides a bad input behind a full page.
  params.push(Number.isFinite(limit) ? limit : 200);
  if (Number.isFinite(offset) && offset > 0) {
    sql += " OFFSET ?";
    params.push(offset);
  }
  return db.prepare(sql).all(...params).map(hydrate);
}

/**
 * Count `DISTINCT testId` across activity rows matching the filter (AUTO-003b).
 *
 * Used by the approval-stats 7-day revert-rate calculation, which asks
 * *"how many distinct tests were auto-approved in the window?"* and
 * *"how many distinct tests were revoked in the window?"* — set sizes,
 * not row counts, because a test that auto-approved twice in the window
 * should still count as one.
 *
 * Previously computed by fetching up to 10,000 rows via `getFiltered`
 * and building two `Set`s in JS; at ~1 KB per row that's ~10 MB of
 * transferred data per project per call. This query returns a single
 * integer, and the `activities(type, projectId, createdAt)` access
 * pattern is index-friendly on both adapters.
 *
 * The `metaIsAutoApproved` filter matches the JSON-encoded flag
 * `meta.wasAutoApproved = true` via a portable `LIKE` on the serialised
 * `meta` TEXT column (migration 018). LIKE is case-sensitive on SQLite
 * and case-insensitive on PostgreSQL (the adapter rewrites LIKE→ILIKE)
 * — fine here because `logActivity` always writes the lowercase
 * `"wasAutoApproved":true` shape, so case-variation isn't possible on
 * real data. Using LIKE instead of `json_extract` keeps the query
 * portable across the SQLite/PostgreSQL adapters without a dialect
 * branch (INF-001).
 *
 * @param {Object} filters
 * @param {string} filters.type                   — required, exact match on `activities.type`.
 * @param {string} [filters.projectId]            — scope to project.
 * @param {string} [filters.workspaceId]          — scope to workspace (ACL).
 * @param {string} [filters.after]                — ISO timestamp lower bound (inclusive).
 * @param {string} [filters.before]               — ISO timestamp upper bound (exclusive).
 * @param {boolean} [filters.metaIsAutoApproved]  — match rows whose `meta`
 *   column encodes `{ ..., "wasAutoApproved": true }`. Used to filter revoke
 *   rows down to "was the revoked test originally auto-approved?" without
 *   reading 10k rows into memory.
 * @returns {number} Count of distinct non-null `testId` values among matching rows.
 */
export function countDistinctTestIds({ type, projectId, workspaceId, after, before, metaIsAutoApproved } = {}) {
  const db = getDatabase();
  let sql = "SELECT COUNT(DISTINCT testId) AS cnt FROM activities WHERE testId IS NOT NULL";
  const params = [];
  if (type) {
    sql += " AND type = ?";
    params.push(type);
  }
  if (projectId) {
    sql += " AND projectId = ?";
    params.push(projectId);
  }
  if (workspaceId) {
    sql += " AND workspaceId = ?";
    params.push(workspaceId);
  }
  if (after) {
    sql += " AND createdAt >= ?";
    params.push(after);
  }
  if (before) {
    sql += " AND createdAt < ?";
    params.push(before);
  }
  if (metaIsAutoApproved) {
    // Portable JSON-in-TEXT probe. Matches the exact substring
    // `"wasAutoApproved":true` (no spaces — `JSON.stringify` omits them)
    // so the filter is stable across both adapters. A dialect-specific
    // `json_extract(meta, '$.wasAutoApproved') = 1` would be nicer on
    // SQLite but breaks on PostgreSQL (`jsonb_extract_path` / `->>`),
    // and the LIKE is already bounded by the indexed `type + projectId`
    // predicates above.
    sql += " AND meta LIKE ?";
    params.push('%"wasAutoApproved":true%');
  }
  return db.prepare(sql).get(...params)?.cnt || 0;
}

/**
 * Count activities with optional workspace/project scope.
 * @param {Object} [filters]
 * @param {string} [filters.workspaceId]
 * @param {string} [filters.projectId]
 * @returns {number}
 */
export function countFiltered({ workspaceId, projectId } = {}) {
  const db = getDatabase();
  let sql = "SELECT COUNT(*) as cnt FROM activities WHERE 1=1";
  const params = [];
  if (workspaceId) {
    sql += " AND workspaceId = ?";
    params.push(workspaceId);
  }
  if (projectId) {
    sql += " AND projectId = ?";
    params.push(projectId);
  }
  return db.prepare(sql).get(...params).cnt;
}

/**
 * Get activities filtered by type for dashboard analytics.
 * Only returns type, status, createdAt — skips detail, names, etc.
 * @param {string[]} types — Activity types to include.
 * @param {Object} [opts]
 * @param {string} [opts.workspaceId] — Optional workspace scope.
 * @returns {Object[]}
 */
export function getByTypes(types, opts = {}) {
  const db = getDatabase();
  const { workspaceId } = opts;
  const placeholders = types.map(() => "?").join(", ");
  const workspaceClause = workspaceId ? " AND workspaceId = ?" : "";
  const params = workspaceId ? [...types, workspaceId] : types;
  return db.prepare(
    `SELECT type, status, createdAt FROM activities WHERE type IN (${placeholders})${workspaceClause} ORDER BY createdAt DESC`
  ).all(...params);
}

/**
 * Delete all activities for a project.
 * @param {string} projectId
 * @returns {number} Number of deleted rows.
 */
export function deleteByProjectId(projectId) {
  const db = getDatabase();
  const info = db.prepare("DELETE FROM activities WHERE projectId = ?").run(projectId);
  return info.changes;
}

/**
 * Delete all activities in a workspace.
 * @param {string} workspaceId
 * @returns {number} Number of deleted rows.
 */
export function clearByWorkspaceId(workspaceId) {
  const db = getDatabase();
  const info = db.prepare("DELETE FROM activities WHERE workspaceId = ?").run(workspaceId);
  return info.changes;
}

/**
 * SEC-007: retention sweep — delete activity rows older than `days` days.
 *
 * Called from the scheduler's daily retention task. The cutoff is computed
 * in JS (ISO 8601 UTC) and passed as a parameterised string so the
 * comparison stays lexicographic — matching the column's storage format
 * and the existing `after` / `before` filters in `getFiltered`.
 *
 * Caller is responsible for the SOC-2 floor (≥ 90 days or 0 to disable);
 * this function simply does what it's told. Boot-time validation in
 * `backend/src/index.js` rejects `AUDIT_RETENTION_DAYS` values below 90.
 *
 * @param {number} days — Retention window in days. Must be > 0; rows with
 *   `createdAt < (now - days)` are deleted. Callers that want to disable
 *   the sweep entirely should not invoke this function at all (the
 *   scheduler honours `AUDIT_RETENTION_DAYS=0` by skipping).
 * @returns {number} Number of deleted rows.
 */
export function purgeOlderThan(days) {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const db = getDatabase();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const info = db.prepare("DELETE FROM activities WHERE createdAt < ?").run(cutoff);
  return info.changes;
}


/**
 * SEC-007: workspace-scoped audit-log fetch with cursor pagination (ENH-010).
 *
 * Cursor pagination — vs. LIMIT/OFFSET — is stable under concurrent writes:
 * a new row arriving between two pages cannot shift the window because the
 * cursor is the row's own `createdAt`, not its ordinal position. The cursor
 * is opaque to the caller (an ISO string), so the API surface can later
 * change to a composite cursor without a breaking change.
 *
 * The ordering tuple is `(createdAt DESC, id DESC)` — matches the INSERT-
 * side tiebreaker in `create()` so sub-millisecond bursts stay deterministic.
 *
 * Filters are AND-combined and all parameterised. `types` is an array; an
 * empty array means "no type filter".
 *
 * @param {string} workspaceId — Required. The authenticated workspace; the
 *   route handler MUST pass `req.workspaceId`, not a user-supplied URL param,
 *   so cross-workspace reads are impossible.
 * @param {Object}   [filters]
 * @param {string}   [filters.userId]
 * @param {string[]} [filters.types]
 * @param {string}   [filters.dateFrom]   — ISO 8601 lower bound (inclusive).
 * @param {string}   [filters.dateTo]     — ISO 8601 upper bound (inclusive).
 * @param {string}   [filters.ipAddress]
 * @param {string}   [filters.cursor]     — Opaque cursor from the previous
 *   page's `nextCursor`. Internally the last row's `createdAt`. Pass
 *   `undefined` (or omit) for the first page.
 * @param {number}   [filters.limit=200]  — Hard-capped at 1000 by the
 *   caller to bound memory.
 * @returns {{ rows: Object[], nextCursor: string|null }} Rows in newest-
 *   first order; `nextCursor` is the timestamp to pass to the next call,
 *   or `null` when there are no more rows.
 */
export function getWorkspaceAuditLog(workspaceId, { userId, projectId, testId, types = [], excludeTypes = [], dateFrom, dateTo, ipAddress, cursor, limit = 200 } = {}) {
  const db = getDatabase();
  // Hard-cap defensively even though the route handler also clamps — a
  // direct repo caller (test, future internal job) shouldn't be able to
  // accidentally pull the whole table.
  const cap = Math.max(1, Math.min(1000, Number.isFinite(limit) ? limit : 200));
  let sql = "SELECT * FROM activities WHERE workspaceId = ?";
  const params = [workspaceId];
  if (userId) { sql += " AND userId = ?"; params.push(userId); }
  if (projectId) { sql += " AND projectId = ?"; params.push(projectId); }
  // ENT-004 (audit) — per-test slice for the "View activity →" link on
  // TestDetail. Workspace ACL is enforced by the leading `workspaceId = ?`
  // predicate; the testId narrow is purely a render-time concern.
  if (testId) { sql += " AND testId = ?"; params.push(testId); }
  if (types?.length) { sql += ` AND type IN (${types.map(() => "?").join(",")})`; params.push(...types); }
  // `excludeTypes` lets the route layer hide high-volume meta-audit types
  // (`audit.read`, `audit.export`) from the default Audit Log view without
  // skipping the rows themselves — PCI-DSS 10.2.6 / SOC 2 CC7.2 still
  // require them to be persisted and reachable; this is a UX filter, not
  // an audit-trail filter. Server-side so pagination math (`limit + 1`,
  // `nextCursor`) stays correct vs. a client-side post-filter that would
  // leave sparse pages and miscount "load more" boundaries.
  if (excludeTypes?.length) { sql += ` AND type NOT IN (${excludeTypes.map(() => "?").join(",")})`; params.push(...excludeTypes); }
  if (dateFrom) { sql += " AND createdAt >= ?"; params.push(dateFrom); }
  if (dateTo) { sql += " AND createdAt <= ?"; params.push(dateTo); }
  if (ipAddress) { sql += " AND ipAddress = ?"; params.push(ipAddress); }
  // Composite cursor — `createdAt|id`. Strict `<` on createdAt with an
  // equal-timestamp tiebreaker on the numeric id avoids the data-loss case
  // where multiple rows share the same `createdAt` and a page boundary falls
  // within them: a plain `createdAt < ?` filter would skip every remaining
  // row at that exact timestamp. The id comparison is numeric (CAST) to
  // match the ORDER BY tiebreaker and the INSERT-side chain ordering.
  if (cursor) {
    const sep = cursor.lastIndexOf("|");
    const cursorTs = sep >= 0 ? cursor.slice(0, sep) : cursor;
    const cursorIdRaw = sep >= 0 ? cursor.slice(sep + 1) : null;
    const cursorIdNum = cursorIdRaw && cursorIdRaw.startsWith("ACT-")
      ? Number.parseInt(cursorIdRaw.slice(4), 10)
      : Number.parseInt(cursorIdRaw, 10);
    if (Number.isFinite(cursorIdNum)) {
      sql += " AND (createdAt < ? OR (createdAt = ? AND CAST(SUBSTR(id, 5) AS INTEGER) < ?))";
      params.push(cursorTs, cursorTs, cursorIdNum);
    } else {
      // Back-compat: legacy timestamp-only cursors still work, just with the
      // known edge-case of skipping rows that share the boundary timestamp.
      sql += " AND createdAt < ?";
      params.push(cursorTs);
    }
  }
  // Fetch one extra row so we can tell whether a next page exists without
  // a second COUNT query. Numeric id tiebreaker matches the INSERT-side
  // ordering in `create()` so sub-millisecond bursts stay deterministic.
  sql += " ORDER BY createdAt DESC, CAST(SUBSTR(id, 5) AS INTEGER) DESC LIMIT ?";
  params.push(cap + 1);
  const all = db.prepare(sql).all(...params).map(hydrate);
  const hasMore = all.length > cap;
  const rows = hasMore ? all.slice(0, cap) : all;
  // Encode the composite (createdAt, id) cursor so the next page can skip
  // past the last row even when several rows share its timestamp.
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? `${last.createdAt}|${last.id}` : null;
  return { rows, nextCursor };
}

/**
 * SEC-007: Walk the audit-log chain for a workspace in chronological order
 * and verify each row's `prevHash` matches the recomputed
 * `sha256(prev.prevHash + JSON.stringify(rowMinusHash(row)))`.
 *
 * Uses the shared `computePrevHash` helper so any drift between the INSERT
 * path and the verification path is impossible — both call the same function.
 *
 * Returns `{ verified: true, total, chainStartedAt }` on a clean walk, or
 * `{ verified: false, firstBrokenRowId, total }` at the first mismatch.
 * An empty workspace is trivially verified.
 *
 * ### Pre-chain rows (`prevHash IS NULL`)
 * When `AUDIT_HASH_CHAIN=true` is enabled on a deployment with pre-existing
 * activity rows, those legacy rows have `prevHash = null` and were never
 * hash-linked. Reporting a tamper break at the first such row would be a
 * false positive — the rows aren't tampered, they predate the feature. So
 * the verifier skips the leading `prevHash IS NULL` rows and begins the
 * walk at the first row with a non-null `prevHash`. `chainStartedAt`
 * surfaces the `createdAt` of that first chained row so operators can
 * see how much history is outside the cryptographic coverage.
 *
 * Caller is expected to gate this behind `AUDIT_HASH_CHAIN=true` — when
 * the chain is disabled, every row has `prevHash = null` and the walk
 * would skip everything (returning `{ verified: true, total, chainStartedAt: null }`).
 * The route handler in `backend/src/routes/system.js` short-circuits to
 * `{ chainDisabled: true }` in that case to avoid the empty-walk ambiguity.
 *
 * @param {string} workspaceId
 * @returns {Object} `{ verified: boolean, firstBrokenRowId?: string, total: number, chainStartedAt?: string|null }`
 */
export function verifyAuditChain(workspaceId) {
  const db = getDatabase();
  // SELECT * so we have every column needed to reproduce `rowMinusHash`.
  // Tiebreaker `id ASC` matches the INSERT-side `id DESC` ordering for
  // sub-millisecond bursts where two rows share the same createdAt.
  // Numeric tiebreaker on the trailing integer of the `ACT-N` id — see the
  // matching DESC ordering in `create()`. Lexicographic `id ASC` would
  // visit ACT-10 immediately after ACT-1, mis-pairing it with ACT-1's hash
  // instead of ACT-9's and breaking the verification walk at every
  // digit-boundary burst.
  const rows = db.prepare(
    "SELECT * FROM activities WHERE workspaceId = ? ORDER BY createdAt ASC, CAST(SUBSTR(id, 5) AS INTEGER) ASC"
  ).all(workspaceId);
  // Skip leading rows that predate chain mode (prevHash IS NULL). These
  // are not tampered — they simply existed before AUDIT_HASH_CHAIN=true was
  // flipped on. See the docstring for the false-positive scenario.
  let startIdx = 0;
  while (startIdx < rows.length && rows[startIdx].prevHash == null) startIdx++;
  const chainStartedAt = startIdx < rows.length ? rows[startIdx].createdAt : null;
  let previousHash = null;
  for (let i = startIdx; i < rows.length; i++) {
    const expected = computePrevHash(previousHash, rows[i]);
    if (rows[i].prevHash !== expected) {
      return { verified: false, firstBrokenRowId: rows[i].id, total: rows.length };
    }
    previousHash = rows[i].prevHash;
  }
  return { verified: true, total: rows.length, chainStartedAt };
}
