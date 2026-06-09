/**
 * @module database/repositories/projectRepo
 * @description Project CRUD backed by SQLite.
 *
 * All read queries filter `WHERE deletedAt IS NULL` by default.
 * Hard deletes are replaced with soft-deletes: `deletedAt = datetime('now')`.
 * Use {@link getDeletedAll} / {@link restore} for recycle-bin operations.
 * Use {@link getAllIncludeDeleted} for data-management cleanup that must
 * span both live and soft-deleted projects.
 */

import { getDatabase } from "../sqlite.js";

// ─── Row ↔ Object helpers ─────────────────────────────────────────────────────
// `credentials` is stored as a JSON string in the DB.

function rowToProject(row) {
  if (!row) return undefined;
  return {
    ...row,
    credentials: row.credentials ? JSON.parse(row.credentials) : null,
    qualityGates: row.qualityGates ? JSON.parse(row.qualityGates) : null,
    webVitalsBudgets: row.webVitalsBudgets ? JSON.parse(row.webVitalsBudgets) : null,
    autoApproveThreshold: row.autoApproveThreshold,
    iterationCap: row.iterationCap,
    strictPiiFirewall: row.strictPiiFirewall === 1,
    piiAllowlist: row.piiAllowlist ? JSON.parse(row.piiAllowlist) : [],
    visionHealing: row.visionHealing || 'off',
    visionHealMaxCallsPerDay: row.visionHealMaxCallsPerDay ?? 100,
    visionHealMaxCostUsdPerMonth: row.visionHealMaxCostUsdPerMonth ?? 50,
    // Migration 058 — Oracle (assertion strengthening) + Reviewer (quality
    // gate) per-project enable flags + per-run cost caps. Safe-off by
    // default at the column level (INTEGER NOT NULL DEFAULT 0) so existing
    // projects are unaffected; surfaced here so API consumers see the
    // canonical shape instead of `undefined`. Cost caps default to $1/run
    // (column REAL DEFAULT 1.0) — `?? 1.0` covers historical rows.
    oracleEnabled: row.oracleEnabled === 1,
    reviewerEnabled: row.reviewerEnabled === 1,
    oracleMaxCostUsdPerRun: row.oracleMaxCostUsdPerRun ?? 1.0,
    reviewerMaxCostUsdPerRun: row.reviewerMaxCostUsdPerRun ?? 1.0,
    coverageEnabled: row.coverageEnabled === 1,
    sourcemapBaseUrl: row.sourcemapBaseUrl || null,
    serverCoverageEndpoint: row.serverCoverageEndpoint || null,
    coverageRegressionThresholdPct: row.coverageRegressionThresholdPct ?? null, // AUTO-009i
    // AUDIT-ROADMAP B2 — iframe enumeration + SPA hydration + adaptive
    // element timeout (migration 069). Defaults mirror the column
    // defaults so callers reading projects created before B2 see the
    // canonical shape instead of `undefined`. `iframeAllowlist` is JSON-
    // encoded in the column and parsed here.
    iframeStrategy: row.iframeStrategy || "same-origin",
    iframeAllowlist: row.iframeAllowlist ? JSON.parse(row.iframeAllowlist) : [],
    hydrationType: row.hydrationType || "auto",
    hydrationSelector: row.hydrationSelector || null,
    elementTimeoutOverride: row.elementTimeoutOverride ?? null,
    // AUDIT-ROADMAP B3 — review-rejection escalation threshold (migration
    // 070). Default 0 (always notify) matches the column default; -1
    // means "never notify" (operator opt-out).
    reviewRejectionAlertThreshold: row.reviewRejectionAlertThreshold ?? 0,
    // AUDIT-ROADMAP B3 — review-rejection notification cooldown timestamp
    // (migration 071). ISO 8601 string; null when no notification has
    // fired yet. Read by `fireReviewRejectionNotifications` to debounce
    // bursts; mirrors `workspaces.spendAlertLastFiredAt` semantics.
    reviewRejectionAlertLastFiredAt: row.reviewRejectionAlertLastFiredAt || null,
    // AUDIT-ROADMAP B4 / RLY-004 — proactive session keep-alive interval
    // (migration 072). `null` (default) disables the ping entirely so
    // every legacy project stays bit-for-bit identical. When set, the
    // testRunner registers a per-page `setInterval` ticker that
    // navigates to `project.url` every N ms to keep server-side
    // sessions alive on long runs. Bounded at the route layer to
    // [60_000, 86_400_000] (1 min ≤ interval ≤ 24 h). Consumer:
    // `backend/src/runner/executeTest.js#startSessionRefreshTicker`.
    sessionRefreshIntervalMs: row.sessionRefreshIntervalMs ?? null,
    // AUDIT-ROADMAP B6 — quality gate toggles (migration 076). All
    // three default safe-off so post-migration behaviour is byte-
    // identical to pre-B6 (acceptance criterion at
    // `docs/roadmap/AUDIT-ROADMAP.md:858-859`).
    dryRunGate:     row.dryRunGate === 1,
    semanticReview: row.semanticReview === 1,
    testDataLocale: row.testDataLocale || "en",
  };
}

function projectToRow(p) {
  return {
    id: p.id,
    name: p.name,
    url: p.url || "",
    credentials: p.credentials ? JSON.stringify(p.credentials) : null,
    status: p.status || "idle",
    qualityGates: p.qualityGates ? JSON.stringify(p.qualityGates) : null,
    webVitalsBudgets: p.webVitalsBudgets ? JSON.stringify(p.webVitalsBudgets) : null,
    createdAt: p.createdAt,
    autoApproveThreshold: p.autoApproveThreshold ?? null,
    iterationCap: p.iterationCap ?? null,
    // Default ON when the caller omits the field — `projects.strictPiiFirewall`
    // is `INTEGER NOT NULL DEFAULT 1` (migration 030) and creating a project
    // via `POST /api/v1/projects` doesn't pass this field through. A naive
    // `p.strictPiiFirewall ? 1 : 0` would coerce `undefined` → 0 and silently
    // disable the SEC-006 PII firewall on every new project, defeating the
    // migration's intent. Only an explicit `false` opts out.
    strictPiiFirewall: p.strictPiiFirewall === false ? 0 : 1,
    piiAllowlist: p.piiAllowlist ? JSON.stringify(p.piiAllowlist) : null,
    visionHealing: p.visionHealing || 'off',
    visionHealMaxCallsPerDay: p.visionHealMaxCallsPerDay ?? 100,
    visionHealMaxCostUsdPerMonth: p.visionHealMaxCostUsdPerMonth ?? 50,
    // Migration 058 — see rowToProject comment. Coerce booleans to 0/1
    // for INTEGER NOT NULL columns; nullish caps fall back to the column
    // default ($1.00/run) so create() doesn't need to specify them.
    oracleEnabled: p.oracleEnabled ? 1 : 0,
    reviewerEnabled: p.reviewerEnabled ? 1 : 0,
    oracleMaxCostUsdPerRun: p.oracleMaxCostUsdPerRun ?? 1.0,
    reviewerMaxCostUsdPerRun: p.reviewerMaxCostUsdPerRun ?? 1.0,
    coverageEnabled: p.coverageEnabled ? 1 : 0,
    sourcemapBaseUrl: p.sourcemapBaseUrl || null,
    serverCoverageEndpoint: p.serverCoverageEndpoint || null,
    coverageRegressionThresholdPct: p.coverageRegressionThresholdPct ?? null, // AUTO-009i
    // AUDIT-ROADMAP B2 — see rowToProject comment. `iframeAllowlist` is
    // JSON-encoded; null / non-array inputs collapse to '[]' so the
    // NOT NULL column constraint never trips. Enum-typed strings
    // (`iframeStrategy`, `hydrationType`) fall back to the canonical
    // default; routes/projects.js already validates the allowed values
    // on the PATCH path, so direct calls (tests, migrations) passing a
    // bad value land the safe default rather than a NOT NULL violation.
    iframeStrategy: p.iframeStrategy || "same-origin",
    iframeAllowlist: Array.isArray(p.iframeAllowlist) ? JSON.stringify(p.iframeAllowlist) : "[]",
    hydrationType: p.hydrationType || "auto",
    hydrationSelector: p.hydrationSelector || null,
    elementTimeoutOverride: Number.isInteger(p.elementTimeoutOverride) ? p.elementTimeoutOverride : null,
    // AUDIT-ROADMAP B3 — see rowToProject. INTEGER column with default 0;
    // explicit `null`/undefined collapses to 0 so create() never trips the
    // column default with a NULL bind from a caller that omits the field.
    reviewRejectionAlertThreshold: Number.isInteger(p.reviewRejectionAlertThreshold) ? p.reviewRejectionAlertThreshold : 0,
    // AUDIT-ROADMAP B4 — nullable INTEGER column. Non-integer / non-finite
    // values collapse to NULL so the route layer can pass `null` to opt
    // out without a special-case bind.
    sessionRefreshIntervalMs: Number.isInteger(p.sessionRefreshIntervalMs) ? p.sessionRefreshIntervalMs : null,
    // AUDIT-ROADMAP B6 — boolean → INTEGER coercion for the two flag
    // columns; `testDataLocale` is TEXT NOT NULL so we collapse
    // nullish to "en" (the column default) to keep the bind safe.
    dryRunGate:     p.dryRunGate ? 1 : 0,
    semanticReview: p.semanticReview ? 1 : 0,
    testDataLocale: typeof p.testDataLocale === "string" && p.testDataLocale.length > 0 ? p.testDataLocale : "en",
  };
}

/**
 * Get all non-deleted projects.
 * @param {string} [workspaceId] — If provided, scope to this workspace (ACL-001).
 * @returns {Object[]}
 */
export function getAll(workspaceId) {
  const db = getDatabase();
  if (workspaceId) {
    return db.prepare("SELECT * FROM projects WHERE deletedAt IS NULL AND workspaceId = ?").all(workspaceId).map(rowToProject);
  }
  return db.prepare("SELECT * FROM projects WHERE deletedAt IS NULL").all().map(rowToProject);
}

/**
 * Get a project by ID (including soft-deleted — needed for restore and audit).
 * Most callers should use {@link getById} which excludes deleted items.
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getByIdIncludeDeleted(id) {
  const db = getDatabase();
  return rowToProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(id));
}

/**
 * Get a non-deleted project by ID.
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getById(id) {
  const db = getDatabase();
  return rowToProject(db.prepare("SELECT * FROM projects WHERE id = ? AND deletedAt IS NULL").get(id));
}

/**
 * Get a non-deleted project by ID, scoped to a workspace (ACL-001).
 * Returns undefined if the project doesn't exist OR belongs to a different workspace.
 * Use this in route handlers to prevent cross-workspace IDOR.
 * @param {string} id
 * @param {string} workspaceId
 * @returns {Object|undefined}
 */
export function getByIdInWorkspace(id, workspaceId) {
  const db = getDatabase();
  return rowToProject(
    db.prepare("SELECT * FROM projects WHERE id = ? AND workspaceId = ? AND deletedAt IS NULL").get(id, workspaceId)
  );
}

/**
 * Create a project.
 * @param {Object} project — Must include `workspaceId` (ACL-001).
 */
export function create(project) {
  const db = getDatabase();
  const row = projectToRow(project);
  row.workspaceId = project.workspaceId || null;
  db.prepare(`
    INSERT INTO projects (id, name, url, credentials, status, qualityGates, webVitalsBudgets, createdAt, workspaceId, autoApproveThreshold, iterationCap, strictPiiFirewall, piiAllowlist, visionHealing, visionHealMaxCallsPerDay, visionHealMaxCostUsdPerMonth, oracleEnabled, reviewerEnabled, oracleMaxCostUsdPerRun, reviewerMaxCostUsdPerRun, coverageEnabled, sourcemapBaseUrl, serverCoverageEndpoint, coverageRegressionThresholdPct, iframeStrategy, iframeAllowlist, hydrationType, hydrationSelector, elementTimeoutOverride, reviewRejectionAlertThreshold, sessionRefreshIntervalMs, dryRunGate, semanticReview, testDataLocale)
    VALUES (@id, @name, @url, @credentials, @status, @qualityGates, @webVitalsBudgets, @createdAt, @workspaceId, @autoApproveThreshold, @iterationCap, @strictPiiFirewall, @piiAllowlist, @visionHealing, @visionHealMaxCallsPerDay, @visionHealMaxCostUsdPerMonth, @oracleEnabled, @reviewerEnabled, @oracleMaxCostUsdPerRun, @reviewerMaxCostUsdPerRun, @coverageEnabled, @sourcemapBaseUrl, @serverCoverageEndpoint, @coverageRegressionThresholdPct, @iframeStrategy, @iframeAllowlist, @hydrationType, @hydrationSelector, @elementTimeoutOverride, @reviewRejectionAlertThreshold, @sessionRefreshIntervalMs, @dryRunGate, @semanticReview, @testDataLocale)
  `).run(row);
}

/**
 * Update specific fields on a project.
 * @param {string} id
 * @param {Object} fields
 */
export function update(id, fields) {
  const db = getDatabase();
  const allowed = ["name", "url", "credentials", "status", "qualityGates", "webVitalsBudgets", "autoApproveThreshold", "iterationCap", "strictPiiFirewall", "piiAllowlist", "visionHealing", "visionHealMaxCallsPerDay", "visionHealMaxCostUsdPerMonth", "oracleEnabled", "reviewerEnabled", "oracleMaxCostUsdPerRun", "reviewerMaxCostUsdPerRun", "coverageEnabled", "sourcemapBaseUrl", "serverCoverageEndpoint", "coverageRegressionThresholdPct", "iframeStrategy", "iframeAllowlist", "hydrationType", "hydrationSelector", "elementTimeoutOverride", "reviewRejectionAlertThreshold", "reviewRejectionAlertLastFiredAt", "sessionRefreshIntervalMs", "dryRunGate", "semanticReview", "testDataLocale"];
  const sets = [];
  const params = { id };
  for (const key of allowed) {
    if (key in fields) {
      let val = (key === "credentials" || key === "qualityGates" || key === "webVitalsBudgets" || key === "piiAllowlist" || key === "iframeAllowlist") && fields[key]
        ? JSON.stringify(fields[key])
        : fields[key];
      // `strictPiiFirewall` is a JS boolean at the route layer but the column
      // is `INTEGER NOT NULL` — better-sqlite3 refuses to bind booleans and
      // throws "SQLite3 can only bind numbers, strings, bigints, buffers,
      // and null". Coerce here so callers can pass a natural `true` / `false`.
      if (key === "strictPiiFirewall" && typeof val === "boolean") {
        val = val ? 1 : 0;
      }
      if (key === "coverageEnabled" && typeof val === "boolean") {
        val = val ? 1 : 0;
      }
      // Migration 058 — Oracle / Reviewer flags share the boolean→INTEGER
      // coercion contract with `strictPiiFirewall` + `coverageEnabled`.
      // Cost-cap columns are REAL, so they pass through unchanged.
      if ((key === "oracleEnabled" || key === "reviewerEnabled") && typeof val === "boolean") {
        val = val ? 1 : 0;
      }
      // AUDIT-ROADMAP B6 — `dryRunGate` + `semanticReview` are INTEGER
      // NOT NULL flag columns; same boolean → INTEGER coercion
      // contract as the surrounding flags. `testDataLocale` is TEXT
      // NOT NULL DEFAULT 'en', so an explicit nullish PATCH collapses
      // to "en" rather than emitting a NOT NULL violation.
      if ((key === "dryRunGate" || key === "semanticReview") && typeof val === "boolean") {
        val = val ? 1 : 0;
      }
      if (key === "testDataLocale" && (val == null || val === "")) {
        val = "en";
      }
      sets.push(`${key} = @${key}`);
      params[key] = val;
    }
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

/**
 * Count total non-deleted projects.
 * @param {string} [workspaceId] — If provided, scope to this workspace (ACL-001).
 * @returns {number}
 */
export function count(workspaceId) {
  const db = getDatabase();
  if (workspaceId) {
    return db.prepare("SELECT COUNT(*) as cnt FROM projects WHERE deletedAt IS NULL AND workspaceId = ?").get(workspaceId).cnt;
  }
  return db.prepare("SELECT COUNT(*) as cnt FROM projects WHERE deletedAt IS NULL").get().cnt;
}

/**
 * Soft-delete a project by ID.
 * The row is retained in the database and visible via {@link getDeletedAll}.
 * Cascade soft-deletes for tests and runs are handled by the caller.
 * @param {string} id
 */
export function deleteById(id) {
  const db = getDatabase();
  db.prepare("UPDATE projects SET deletedAt = datetime('now') WHERE id = ?").run(id);
}

/**
 * Hard-delete a project by ID (permanent — use only for purge operations).
 * @param {string} id
 */
export function hardDeleteById(id) {
  const db = getDatabase();
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

/**
 * Get all projects (live + soft-deleted) for a workspace.
 * Used by data-management cleanup endpoints that must clear derived data
 * across all projects regardless of soft-delete status.
 * @param {string} workspaceId
 * @returns {Object[]}
 */
export function getAllIncludeDeleted(workspaceId) {
  return [...getAll(workspaceId), ...getDeletedAll(workspaceId)];
}

/**
 * Get all soft-deleted projects (recycle bin).
 * @param {string} [workspaceId] — If provided, scope to this workspace (ACL-001).
 * @returns {Object[]}
 */
export function getDeletedAll(workspaceId) {
  const db = getDatabase();
  if (workspaceId) {
    return db.prepare("SELECT * FROM projects WHERE deletedAt IS NOT NULL AND workspaceId = ? ORDER BY deletedAt DESC").all(workspaceId).map(rowToProject);
  }
  return db.prepare("SELECT * FROM projects WHERE deletedAt IS NOT NULL ORDER BY deletedAt DESC").all().map(rowToProject);
}

/**
 * Restore a soft-deleted project (clear deletedAt).
 * @param {string} id
 * @returns {boolean} Whether the project was found and restored.
 */
export function restore(id) {
  const db = getDatabase();
  const info = db.prepare("UPDATE projects SET deletedAt = NULL WHERE id = ? AND deletedAt IS NOT NULL").run(id);
  return info.changes > 0;
}
