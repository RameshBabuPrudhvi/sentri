/**
 * @module routes/system
 * @description System info, activities, data management, and URL reachability. Mounted at `/api/v1` (INF-005).
 *
 * All queries are scoped to the authenticated user's workspace (ACL-001).
 *
 * ### Endpoints
 * | Method   | Path                          | Description                                | Min Role  |
 * |----------|-------------------------------|--------------------------------------------|-----------|
 * | `GET`    | `/api/v1/activities`          | Activity log (filterable by type, project)  | viewer    |
 * | `POST`   | `/api/v1/test-connection`     | Verify a URL is reachable (SSRF-protected)  | qa_lead   |
 * | `GET`    | `/api/v1/system`              | Uptime, Node/Playwright versions, DB counts | viewer    |
 * | `POST`   | `/api/v1/system/client-error` | Log a frontend crash report                 | viewer    |
 * | `DELETE` | `/api/v1/data/runs`           | Clear all run history (incl. soft-deleted)  | admin     |
 * | `DELETE` | `/api/v1/data/activities`     | Clear activity log                          | admin     |
 * | `DELETE` | `/api/v1/data/healing`        | Clear self-healing history                  | admin     |
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as activityRepo from "../database/repositories/activityRepo.js";
import * as auditDlqRepo from "../database/repositories/auditDlqRepo.js";
import * as workspaceSiemConfigRepo from "../database/repositories/workspaceSiemConfigRepo.js";
import * as healingRepo from "../database/repositories/healingRepo.js";
import { validateUrl } from "../utils/ssrfGuard.js";
import { logActivity } from "../utils/activityLogger.js";
import { actor } from "../utils/actor.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { activeTaskCount } from "../scheduler.js";
import { requireRole } from "../middleware/requireRole.js";
import { SYSTEM_WORKSPACE_ID } from "../constants/systemWorkspace.js";

const router = Router();

/**
 * SEC-007: anti-exfiltration rate limiter for bulk audit-log exports.
 *
 * Browsing the JSON paginated view is cheap; CSV/NDJSON exports return the
 * entire current page in one shot and a determined exfiltrator can
 * script the cursor loop to pull the whole log in seconds. Cap export
 * calls at 10 per 15-min window per (workspace × admin) — generous for
 * legitimate evidence requests (SOC 2 control-walk, customer DSAR), tight
 * enough that a script tripping the limit shows up as a clear signal in
 * both the rate-limit logs and the meta-audit `audit.export` rows.
 *
 * The keyGenerator includes `req.workspaceId + sub` so a compromised admin
 * cookie can't burn the budget of an unrelated workspace.
 */
const auditExportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUDIT_EXPORT_RATE_LIMIT ?? "", 10) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.workspaceId || "no-ws"}::${req.authUser?.sub || req.ip || "anon"}`,
  // Only count *export* calls toward the budget — JSON browsing is exempt.
  // `skip` is evaluated BEFORE `keyGenerator` in express-rate-limit, so a
  // skipped JSON read never touches the rate-limit store at all. Anti-
  // exfiltration coverage for JSON paginated reads is provided by the
  // server-side `audit.read` meta-audit row emitted on every call (PCI-DSS
  // 10.2.6) — a scripted full-table walk leaves a one-for-one trail in
  // the same compliance log it's trying to exfiltrate, which is the
  // documented & accepted residual risk.
  skip: (req) => req.query.format !== "csv" && req.query.format !== "ndjson",
  message: {
    error: "Too many audit-log exports. Try again later.",
    code: "AUDIT_EXPORT_RATE_LIMITED",
  },
});

// ─── Activities ───────────────────────────────────────────────────────────────

router.get("/activities", (req, res) => {
  // Cap `limit` at 1000 so a malformed client can't pull the entire table
  // in one request — the AUTO-003b approvals timeline reads 200 at a time
  // and pages via `offset`. The default stays 200 to keep existing callers
  // (Settings → System activity widget, ReviewQueue auto-tray) unchanged.
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, rawLimit)) : 200;
  const rawOffset = parseInt(req.query.offset, 10);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : undefined;
  // `after` / `before` accept ISO-8601 strings; the repo does a lexicographic
  // string comparison against `createdAt` (also ISO). Pass through as-is —
  // any malformed value would simply match no rows rather than throw, and
  // the repo doesn't trust the input for SQL (parameterised).
  const activities = activityRepo.getFiltered({
    type: req.query.type || undefined,
    projectId: req.query.projectId || undefined,
    workspaceId: req.workspaceId,
    after: req.query.after || undefined,
    before: req.query.before || undefined,
    limit,
    offset,
  });
  res.json(activities);
});


/**
 * SEC-007: verify the audit-log hash chain for the caller's workspace.
 *
 * No-op when `AUDIT_HASH_CHAIN` is unset (returns `chainDisabled: true`) —
 * the chain feature flag is off by default because chained writes
 * serialise INSERTs under contention.
 *
 * @route GET /api/v1/audit/verify
 */
router.get("/audit/verify", requireRole("admin"), (req, res) => {
  try {
    if (process.env.AUDIT_HASH_CHAIN !== "true") {
      return res.json({ verified: true, chainDisabled: true });
    }
    return res.json(activityRepo.verifyAuditChain(req.workspaceId));
  } catch (err) {
    // AGENT.md: 5xx never leaks internal details. Log server-side, return
    // a stable error code the frontend can branch on.
    console.error(formatLogLine("error", null, `[audit/verify] ${err.message}`));
    return res.status(500).json({ error: "Audit chain verification unavailable.", code: "AUDIT_VERIFY_FAILED" });
  }
});

/**
 * SEC-007: list system-scoped security events (workspaceId = SYSTEM_WORKSPACE_ID).
 *
 * These are audit rows that fire BEFORE a tenant can be resolved — chiefly
 * `auth.login.failed` against unknown emails (credential-stuffing probes
 * against the deployment as a whole). Routing them to the system sentinel
 * workspace keeps them queryable without leaking any tenant's existence
 * via the side-channel of "which workspace did the row land in?".
 *
 * Cross-tenant by design — only deployment-level admins should see this
 * surface. We gate on `requireRole("admin")` AND require that the caller's
 * own workspace is non-system (a defence-in-depth check; no real workspace
 * uses the sentinel ID, but listing this route on it would be confusing).
 *
 * Reuses `getFiltered` rather than `getWorkspaceAuditLog` because the
 * latter's cursor pagination and meta-audit emission make sense for
 * tenant audit logs, not the deployment-wide security-events stream.
 *
 * @route GET /api/v1/system/security-events
 */
router.get("/system/security-events", requireRole("admin"), (req, res) => {
  try {
    // Defence-in-depth: the system sentinel is never a real workspace, so
    // a request whose own scope IS the sentinel is malformed (or an attempt
    // to spoof access). Reject explicitly.
    if (req.workspaceId === SYSTEM_WORKSPACE_ID) {
      return res.status(403).json({
        error: "Caller workspace cannot be the system sentinel.",
        code: "SYSTEM_SCOPE_MISUSE",
      });
    }
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, rawLimit)) : 200;
    const rawOffset = Number.parseInt(req.query.offset, 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : undefined;
    const rows = activityRepo.getFiltered({
      workspaceId: SYSTEM_WORKSPACE_ID,
      type: req.query.type || undefined,
      after: req.query.after || undefined,
      before: req.query.before || undefined,
      limit,
      offset,
    });
    return res.json({ rows, count: rows.length });
  } catch (err) {
    console.error(formatLogLine("error", null, `[system/security-events] ${err.message}`));
    return res.status(500).json({
      error: "System security events unavailable.",
      code: "SYSTEM_SECURITY_EVENTS_FAILED",
    });
  }
});

/**
 * SEC-007: workspace-scoped audit log. Admin-gated. Returns rows in newest-
 * first order with opaque cursor pagination (`nextCursor`). Supports
 * `?format=csv` and `?format=ndjson` exports of the current page.
 *
 * ### Authorisation contract
 * The `:workspaceId` URL param is validated against `req.workspaceId` (the
 * authenticated workspace injected by `workspaceScope` middleware). A 403 is
 * returned on mismatch — without this check an admin in workspace A could
 * read workspace B's audit log by changing the URL.
 *
 * ### Query params
 * | Param      | Type     | Notes                                          |
 * |------------|----------|------------------------------------------------|
 * | userId     | string   | Filter by acting user.                         |
 * | type       | string|string[] | Repeat to filter by multiple types.     |
 * | dateFrom   | ISO date | Inclusive lower bound.                         |
 * | dateTo     | ISO date | Inclusive upper bound.                         |
 * | ipAddress  | string   | Exact-match filter.                            |
 * | cursor     | ISO date | Opaque cursor from previous page's nextCursor. |
 * | limit      | int      | 1..1000, default 200.                          |
 * | format     | csv\|ndjson | Exports the current page in that format.    |
 *
 * @route GET /api/v1/workspaces/:workspaceId/audit-log
 */
router.get("/workspaces/:workspaceId/audit-log", requireRole("admin"), auditExportLimiter, (req, res) => {
  try {
    // ── Authorisation: URL param must match the authenticated workspace ──
    // Without this, the URL param overrides the middleware-injected scope
    // and an admin in workspace A can read workspace B's audit log just by
    // editing the URL. Return 403 (not 404) so we don't leak whether the
    // target workspace exists.
    if (req.params.workspaceId !== req.workspaceId) {
      return res.status(403).json({
        error: "Audit log is scoped to your authenticated workspace.",
        code: "AUDIT_WORKSPACE_MISMATCH",
      });
    }

    // ── Parse + validate query params ──
    const types = Array.isArray(req.query.type)
      ? req.query.type
      : (req.query.type ? [req.query.type] : []);
    // Same hard cap as the existing /activities route (line 41) so an
    // attacker cannot pull the entire table with ?limit=999999.
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, rawLimit)) : 200;
    const cursor = typeof req.query.cursor === "string" && req.query.cursor.length > 0
      ? req.query.cursor
      : undefined;

    // ── Fetch ──
    const { rows, nextCursor } = activityRepo.getWorkspaceAuditLog(req.workspaceId, {
      userId: req.query.userId || undefined,
      projectId: req.query.projectId || undefined,
      types,
      dateFrom: req.query.dateFrom || undefined,
      dateTo: req.query.dateTo || undefined,
      ipAddress: req.query.ipAddress || undefined,
      cursor,
      limit,
    });

    // ── Meta-audit: log every audit-log access ──
    // PCI-DSS 10.2.6 and SOC 2 CC7.2 require that *reads of the audit log
    // are themselves audited*. Without this, an insider with admin access
    // could exfiltrate the entire compliance trail with zero trace.
    //
    // The actual filter shape goes into `meta` so a reviewer can later
    // answer "who read the audit log, for which window, and how?".
    // Exports use a distinct `audit.export` type so anti-exfiltration
    // dashboards can alert on bulk export bursts separately from
    // routine UI browsing.
    const isExport = req.query.format === "csv" || req.query.format === "ndjson";
    logActivity({
      type: isExport ? "audit.export" : "audit.read",
      req,
      userId: req.authUser?.sub || null,
      userName: req.authUser?.name || req.authUser?.email || null,
      workspaceId: req.workspaceId,
      meta: {
        format: req.query.format || "json",
        rowCount: rows.length,
        filters: {
          userId: req.query.userId || null,
          projectId: req.query.projectId || null,
          types: types.length ? types : null,
          dateFrom: req.query.dateFrom || null,
          dateTo: req.query.dateTo || null,
          ipAddress: req.query.ipAddress || null,
          cursor: cursor || null,
          limit,
        },
      },
    });

    // ── Export formats ──
    if (req.query.format === "ndjson") {
      res.setHeader("Content-Type", "application/x-ndjson");
      // Disposition hint for browsers that open the response directly.
      res.setHeader("Content-Disposition", `attachment; filename="sentri-audit-log-${new Date().toISOString().slice(0, 10)}.ndjson"`);
      return res.send(rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    }
    if (req.query.format === "csv") {
      // RFC 4180: wrap every field in quotes, double internal quotes.
      // First column header is `createdAt` to match the NDJSON/JSON field
      // name — SIEM importers joining CSV and NDJSON exports otherwise
      // need a mapping table for the `timestamp` ↔ `createdAt` rename.
      const header = "createdAt,userId,userName,type,meta,ipAddress,userAgent,workspaceId";
      const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
      const body = rows.map((r) =>
        [r.createdAt, r.userId, r.userName, r.type, JSON.stringify(r.meta ?? null), r.ipAddress, r.userAgent, r.workspaceId]
          .map(esc).join(","),
      ).join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="sentri-audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(`${header}\n${body}${body ? "\n" : ""}`);
    }

    return res.json({ rows, nextCursor });
  } catch (err) {
    // AGENT.md: 5xx errors never leak internal details. Log server-side,
    // return a stable code so the UI can render a clean "try again" state.
    console.error(formatLogLine("error", null, `[audit-log] ${err.message}`));
    return res.status(500).json({ error: "Audit log unavailable.", code: "AUDIT_READ_FAILED" });
  }
});

/**
 * SEC-007: list SIEM dead-letter queue entries for the caller's workspace.
 *
 * The DLQ stores audit events that the SIEM forwarder (Part C) failed to
 * deliver after exhausting its retry budget. Admins use this list +
 * `POST .../replay` to recover from transient outages at the SIEM target.
 *
 * Workspace-scope is enforced by comparing the URL `:workspaceId` against
 * `req.workspaceId` — same pattern as the audit-log route above.
 *
 * @route GET /api/v1/workspaces/:workspaceId/audit-log/dlq
 */
router.get("/workspaces/:workspaceId/audit-log/dlq", requireRole("admin"), (req, res) => {
  try {
    if (req.params.workspaceId !== req.workspaceId) {
      return res.status(403).json({
        error: "Audit DLQ is scoped to your authenticated workspace.",
        code: "AUDIT_WORKSPACE_MISMATCH",
      });
    }
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, rawLimit)) : 200;
    const rows = auditDlqRepo.listByWorkspace(req.workspaceId, { limit });
    return res.json({ rows, count: rows.length });
  } catch (err) {
    console.error(formatLogLine("error", null, `[audit-log/dlq] ${err.message}`));
    return res.status(500).json({ error: "Audit DLQ unavailable.", code: "AUDIT_DLQ_READ_FAILED" });
  }
});

/**
 * SEC-007: replay a single DLQ entry against the SIEM forwarder.
 *
 * Re-dispatches the stored snapshot. On success the DLQ row is removed.
 * On failure the attempt counter increments and the latest error is
 * recorded so the next replay attempt sees the freshest context.
 *
 * Pre-Part-C state: the SIEM forwarder (`dispatchSiemEvent`) does not yet
 * exist, so this route returns `503 SIEM_NOT_CONFIGURED` to signal that
 * the configured SIEM target is missing. The handler is shaped so that
 * dropping in the forwarder later (C2) is a one-line change.
 *
 * Workspace-scope: both the URL param AND the row's stored `workspaceId`
 * are checked so even if the DLQ row's path was guessed, an admin in a
 * different workspace can't replay it.
 *
 * @route POST /api/v1/workspaces/:workspaceId/audit-log/dlq/:dlqId/replay
 */
router.post("/workspaces/:workspaceId/audit-log/dlq/:dlqId/replay", requireRole("admin"), async (req, res) => {
  try {
    if (req.params.workspaceId !== req.workspaceId) {
      return res.status(403).json({
        error: "Audit DLQ is scoped to your authenticated workspace.",
        code: "AUDIT_WORKSPACE_MISMATCH",
      });
    }
    const row = auditDlqRepo.getById(req.params.dlqId);
    if (!row) {
      return res.status(404).json({ error: "DLQ entry not found.", code: "AUDIT_DLQ_NOT_FOUND" });
    }
    // Defence-in-depth: even if a future bug let the URL param drift from
    // the row's workspace, the row's stored workspaceId is the source of
    // truth for cross-tenant isolation.
    if (row.workspaceId !== req.workspaceId) {
      return res.status(403).json({
        error: "DLQ entry belongs to a different workspace.",
        code: "AUDIT_WORKSPACE_MISMATCH",
      });
    }

    // ── Re-dispatch via the SIEM forwarder ──
    // The forwarder lives in `utils/notifications.js` (Part C). Until that
    // lands, fail loudly with a stable code instead of silently succeeding
    // — operators must know the replay was a no-op.
    let dispatchSiemEvent = null;
    try {
      const mod = await import("../utils/notifications.js");
      dispatchSiemEvent = mod.dispatchSiemEvent || null;
    } catch { /* module not present in tests — treated as not-configured */ }

    if (typeof dispatchSiemEvent !== "function") {
      return res.status(503).json({
        error: "SIEM forwarder is not configured on this server.",
        code: "SIEM_NOT_CONFIGURED",
      });
    }

    // `dispatchSiemEvent` is fire-and-forget: it NEVER throws and returns
    // `{ ok, attempts?, lastError? }` instead. The catch is kept as a
    // defence-in-depth guard for unexpected synchronous errors (e.g. the
    // dynamic import resolving to a broken module).
    let result;
    try {
      result = await dispatchSiemEvent(row.workspaceId, row.rowSnapshot);
    } catch (dispatchErr) {
      const attempts = auditDlqRepo.incrementAttempts(row.id, dispatchErr.message || String(dispatchErr));
      return res.status(502).json({
        error: "Replay failed at the SIEM target.",
        code: "SIEM_DISPATCH_FAILED",
        attempts,
      });
    }

    // Branch on the documented return contract.
    if (!result || result.ok !== true) {
      // No SIEM config / disabled → surface as 503 SIEM_NOT_CONFIGURED so
      // the UI distinguishes a config gap from a transport failure.
      if (result?.lastError === "siem-not-configured") {
        return res.status(503).json({
          error: "SIEM forwarder is not configured for this workspace.",
          code: "SIEM_NOT_CONFIGURED",
        });
      }
      // Real dispatch failure — record the attempt and surface a 502.
      // The forwarder itself already enqueued a fresh DLQ row; bump the
      // *original* row's attempts so the inspector reflects the retry.
      const attempts = auditDlqRepo.incrementAttempts(row.id, result?.lastError || "unknown");
      return res.status(502).json({
        error: "Replay failed at the SIEM target.",
        code: "SIEM_DISPATCH_FAILED",
        attempts,
      });
    }

    // Success — remove the DLQ row so it doesn't reappear in the inspector.
    auditDlqRepo.remove(row.id);
    return res.json({ ok: true, id: row.id, replayedAt: new Date().toISOString() });
  } catch (err) {
    console.error(formatLogLine("error", null, `[audit-log/dlq/replay] ${err.message}`));
    return res.status(500).json({ error: "Audit DLQ replay unavailable.", code: "AUDIT_DLQ_REPLAY_FAILED" });
  }
});

/**
 * SEC-007 Part C: GET per-workspace SIEM forwarder configuration.
 *
 * Returns the masked config — `hmacSecret` is replaced with
 * `••••••••<last4>` so admins can confirm which secret is configured
 * without exposing the value. Returns `{ config: null }` when no
 * config exists.
 *
 * @route GET /api/v1/workspaces/:workspaceId/siem-config
 */
router.get("/workspaces/:workspaceId/siem-config", requireRole("admin"), (req, res) => {
  try {
    if (req.params.workspaceId !== req.workspaceId) {
      return res.status(403).json({
        error: "SIEM config is scoped to your authenticated workspace.",
        code: "AUDIT_WORKSPACE_MISMATCH",
      });
    }
    const config = workspaceSiemConfigRepo.getMasked(req.workspaceId);
    return res.json({ config });
  } catch (err) {
    console.error(formatLogLine("error", null, `[siem-config] ${err.message}`));
    return res.status(500).json({ error: "SIEM config unavailable.", code: "SIEM_CONFIG_READ_FAILED" });
  }
});

/**
 * SEC-007 Part C: PUT (upsert) per-workspace SIEM forwarder configuration.
 *
 * The HMAC secret is encrypted at rest via `credentialEncryption.js`.
 * The target URL is validated against the SSRF guard so cloud-metadata
 * endpoints / RFC 1918 ranges / link-local / etc. are rejected at write
 * time. The `headers` object is bounded at 4096 chars JSON-serialised to
 * stop a malicious admin from blowing out the DB.
 *
 * The route emits a `settings.update` activity (workspace-scoped) on
 * success so the change is audit-trailed alongside other admin
 * configuration changes.
 *
 * @route PUT /api/v1/workspaces/:workspaceId/siem-config
 */
router.put("/workspaces/:workspaceId/siem-config", requireRole("admin"), async (req, res) => {
  try {
    if (req.params.workspaceId !== req.workspaceId) {
      return res.status(403).json({
        error: "SIEM config is scoped to your authenticated workspace.",
        code: "AUDIT_WORKSPACE_MISMATCH",
      });
    }

    const { targetUrl, hmacSecret, headers, enabled } = req.body || {};

    // Required-field validation up front — clearer errors than the SSRF
    // check tripping on undefined.
    if (typeof targetUrl !== "string" || !targetUrl.trim()) {
      return res.status(400).json({ error: "targetUrl is required.", code: "SIEM_CONFIG_INVALID" });
    }
    // SEC-007: `hmacSecret` is conditionally required.
    //   - On INSERT (no existing row) → required, ≥ 32 chars.
    //   - On UPDATE (row exists)      → optional. Omit or pass empty string
    //     to keep the existing encrypted secret; pass ≥ 32 chars to rotate.
    //
    // The 32-char floor follows NIST SP 800-107 (HMAC key length should be
    // ≥ output length; SHA-256 → 32 bytes). We accept arbitrary printable
    // ASCII (operators may paste base64 / hex / passphrase form), so 32
    // chars guarantees ≥ 192 bits of entropy even at the lowercase-only
    // worst case.
    const existingConfig = workspaceSiemConfigRepo.getMasked(req.workspaceId);
    const hasNewSecret = typeof hmacSecret === "string" && hmacSecret.length > 0;
    if (!existingConfig && !hasNewSecret) {
      return res.status(400).json({
        error: "hmacSecret is required when creating a new SIEM config.",
        code: "SIEM_CONFIG_INVALID",
      });
    }
    if (hasNewSecret && hmacSecret.length < 32) {
      return res.status(400).json({
        error: "hmacSecret must be at least 32 characters.",
        code: "SIEM_CONFIG_INVALID",
      });
    }

    // SSRF: block cloud metadata + private ranges + link-local. Same
    // validator the notification webhook config uses. ALLOW_PRIVATE_URLS
    // escape hatch is honoured for dev/CI per the existing pattern.
    if (process.env.ALLOW_PRIVATE_URLS !== "true") {
      const ssrfErr = await validateUrl(targetUrl);
      if (ssrfErr) {
        return res.status(400).json({ error: ssrfErr, code: "SIEM_CONFIG_INVALID_URL" });
      }
    }

    // Bound `headers` size — an admin pasting 100KB of headers would
    // (a) bloat the DB row and (b) make every dispatched HTTP request
    // larger than necessary. 4096 chars JSON is generous for legitimate
    // SIEM-vendor token headers (Splunk HEC tokens are ~36 chars).
    if (headers !== undefined && headers !== null) {
      if (typeof headers !== "object" || Array.isArray(headers)) {
        return res.status(400).json({ error: "headers must be an object.", code: "SIEM_CONFIG_INVALID" });
      }
      if (JSON.stringify(headers).length > 4096) {
        return res.status(400).json({ error: "headers exceeds 4096 chars.", code: "SIEM_CONFIG_INVALID" });
      }
      // SEC-007: defence-in-depth against header overwrite. The forwarder
      // (`backend/src/utils/notifications.js`) already spreads custom headers
      // first so system-controlled integrity headers cannot be clobbered, but
      // we also reject the names at write time so a misconfigured admin sees
      // a clear 400 instead of a silently-ignored value. Case-insensitive
      // match: HTTP header names are case-insensitive per RFC 7230.
      const reserved = new Set(["content-type", "x-sentri-audit-signature"]);
      for (const key of Object.keys(headers)) {
        if (reserved.has(key.toLowerCase())) {
          return res.status(400).json({
            error: `Header "${key}" is reserved and cannot be overridden.`,
            code: "SIEM_CONFIG_RESERVED_HEADER",
          });
        }
      }
    }

    const persisted = workspaceSiemConfigRepo.upsert(req.workspaceId, {
      targetUrl: targetUrl.trim(),
      hmacSecret,
      headers: headers || null,
      enabled: enabled !== false, // default true
    });

    // Audit-trail the config change. The hmacSecret is NOT in the meta —
    // only the targetUrl + enabled state, so the activity row is safe to
    // expose to any admin viewing the workspace audit log.
    logActivity({
      ...actor(req),
      type: "settings.update",
      req,
      workspaceId: req.workspaceId,
      detail: `SIEM forwarder ${enabled === false ? "disabled" : "configured"} (${targetUrl})`,
      meta: { surface: "siem-config", targetUrl: targetUrl.trim(), enabled: enabled !== false },
    });

    return res.json({ config: persisted });
  } catch (err) {
    console.error(formatLogLine("error", null, `[siem-config/upsert] ${err.message}`));
    return res.status(500).json({ error: "SIEM config save unavailable.", code: "SIEM_CONFIG_WRITE_FAILED" });
  }
});

/**
 * SEC-007 Part C: DELETE the per-workspace SIEM forwarder configuration.
 *
 * Idempotent — returns `{ ok: true, removed: false }` when no config
 * existed. Emits a `settings.update` activity for audit trail.
 *
 * @route DELETE /api/v1/workspaces/:workspaceId/siem-config
 */
router.delete("/workspaces/:workspaceId/siem-config", requireRole("admin"), (req, res) => {
  try {
    if (req.params.workspaceId !== req.workspaceId) {
      return res.status(403).json({
        error: "SIEM config is scoped to your authenticated workspace.",
        code: "AUDIT_WORKSPACE_MISMATCH",
      });
    }
    const removed = workspaceSiemConfigRepo.remove(req.workspaceId);
    if (removed) {
      logActivity({
        ...actor(req),
        type: "settings.update",
        req,
        workspaceId: req.workspaceId,
        detail: "SIEM forwarder configuration removed",
        meta: { surface: "siem-config", action: "delete" },
      });
    }
    return res.json({ ok: true, removed });
  } catch (err) {
    console.error(formatLogLine("error", null, `[siem-config/delete] ${err.message}`));
    return res.status(500).json({ error: "SIEM config delete unavailable.", code: "SIEM_CONFIG_DELETE_FAILED" });
  }
});

// ─── URL reachability test ────────────────────────────────────────────────────

router.post("/test-connection", requireRole("qa_lead"), async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "URL must use http or https protocol" });
  }
  // SSRF protection: block loopback, link-local, and private IP ranges.
  //
  // Dev escape hatch — when `ALLOW_PRIVATE_URLS=true`, skip the SSRF check so
  // developers can Test against `http://localhost:3000`, Dockerised stacks, or
  // internal staging hostnames (mirrors the `SKIP_EMAIL_VERIFICATION` pattern).
  // Never set this in production — it permits SSRF to cloud metadata endpoints
  // (169.254.169.254), databases on the local network, etc.
  if (process.env.ALLOW_PRIVATE_URLS === "true") {
    try {
      const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10000) });
      return res.json({ ok: true, status: response.status });
    } catch (err) {
      return res.status(502).json({ ok: false, error: err.message });
    }
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  function extractMappedIPv4(host) {
    const dottedMatch = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (dottedMatch) return dottedMatch[1];
    const hexMatch = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
    return null;
  }

  function isPrivateIPv4(ip) {
    return (
      /^127\.\d+\.\d+\.\d+$/.test(ip) ||
      /^10\.\d+\.\d+\.\d+$/.test(ip) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(ip) ||
      /^192\.168\.\d+\.\d+$/.test(ip) ||
      ip === "0.0.0.0" ||
      ip === "169.254.169.254"
    );
  }

  const mappedIPv4 = extractMappedIPv4(hostname);
  const blocked =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isPrivateIPv4(hostname) ||
    (mappedIPv4 && isPrivateIPv4(mappedIPv4)) ||
    hostname === "0.0.0.0" ||
    hostname === "::" ||
    hostname === "::1" ||
    (/^::ffff:/i.test(hostname) && mappedIPv4 === null) ||
    hostname === "169.254.169.254" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".internal") ||
    /^fe80:/i.test(hostname) ||
    /^fd[0-9a-f]{2}:/i.test(hostname) ||
    /^fc[0-9a-f]{2}:/i.test(hostname);
  if (blocked) {
    return res.status(400).json({ error: "URL must not point to localhost, private, or internal addresses" });
  }
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10000) });
    res.json({ ok: true, status: response.status });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ─── System Info ──────────────────────────────────────────────────────────────

router.get("/system", async (req, res) => {
  let playwrightVersion = null;
  try {
    const pwPkg = await import("playwright/package.json", { with: { type: "json" } }).catch(() => null);
    playwrightVersion = pwPkg?.default?.version || null;
  } catch { /* ignore */ }

  if (!playwrightVersion) {
    try {
      const { createRequire } = await import("module");
      const require = createRequire(import.meta.url);
      const pwPkg = require("playwright/package.json");
      playwrightVersion = pwPkg.version;
    } catch { /* ignore */ }
  }

  const projects = projectRepo.getAll(req.workspaceId);
  const projectIds = projects.map((p) => p.id);
  // Use SQL-level counts instead of loading all test rows into memory.
  const testCount = testRepo.countByProjectIds(projectIds);
  const approvedTests = testRepo.countApprovedByProjectIds(projectIds);
  const draftTests = testRepo.countDraftByProjectIds(projectIds);
  // Healing counts need test IDs — use the lightweight ID-only query.
  const testIds = testRepo.getAllIdsByProjectIdsIncludeDeleted(projectIds);

  const projectCount = projects.length;
  const runCount = runRepo.countByProjectIds(projectIds);
  const activityCount = activityRepo.countFiltered({ workspaceId: req.workspaceId });
  const healingEntries = healingRepo.countByTestIds(testIds);

  res.json({
    projects:     projectCount,
    tests:        testCount,
    runs:         runCount,
    activities:   activityCount,
    healingEntries,
    approvedTests,
    draftTests,
    uptime:        Math.floor(process.uptime()),
    nodeVersion:   process.version,
    playwrightVersion,
    memoryMB:      Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    activeSchedules: activeTaskCount(),
  });
});

// ─── Client error reporting ───────────────────────────────────────────────────
// Receives crash reports from the frontend ErrorBoundary (componentDidCatch).
// Logs the error server-side so crashes are visible in backend logs even when
// the user doesn't report them. The endpoint intentionally does minimal work
// and always returns 200 — it must never throw back to the already-crashed UI.

router.post("/system/client-error", (req, res) => {
  const { message, stack, componentStack, url } = req.body || {};
  console.error(formatLogLine("error", null,
    `[client-error] ${message || "Unknown error"} at ${url || "unknown URL"}` +
    (stack ? `\n${stack}` : "") +
    (componentStack ? `\nComponent stack:${componentStack}` : ""),
  ));
  res.json({ ok: true });
});

// ─── Data Management ──────────────────────────────────────────────────────────

router.delete("/data/runs", requireRole("admin"), (req, res) => {
  const projects = projectRepo.getAllIncludeDeleted(req.workspaceId);
  const count = projects.reduce((sum, p) => sum + runRepo.hardDeleteByProjectId(p.id).length, 0);
  logActivity({ ...actor(req), type: "settings.update", detail: `Cleared ${count} run(s)` });
  res.json({ ok: true, cleared: count });
});

router.delete("/data/activities", requireRole("admin"), (req, res) => {
  if (process.env.DANGER_ALLOW_AUDIT_PURGE !== "true") {
    return res.status(403).json({ error: "Audit purge is disabled.", code: "AUDIT_PURGE_DISABLED" });
  }
  // SEC-007: emit the meta-audit row BEFORE the truncate so the act of purging
  // the audit log is itself recorded — and survives the very purge it audits.
  // Without this, the single most security-sensitive admin action in the
  // system (wiping the compliance trail) would leave zero in-DB evidence,
  // making PCI-DSS 10.2.6 / SOC 2 CC7.2 untenable. The env-var flip
  // (`DANGER_ALLOW_AUDIT_PURGE=true`) lives outside the DB and is the only
  // other deployment-level signal; this row gives reviewers a workspace-
  // scoped trail in addition. It is also pushed to the SIEM forwarder via
  // the standard `logActivity` path so external evidence survives even if
  // the operator then changes the truncate to clear the entire table.
  logActivity({
    ...actor(req),
    type: "audit.purge",
    req,
    workspaceId: req.workspaceId,
    detail: "Audit log truncated via DELETE /data/activities (DANGER_ALLOW_AUDIT_PURGE=true).",
    meta: { surface: "data-management", envFlag: "DANGER_ALLOW_AUDIT_PURGE" },
  });
  const count = activityRepo.clearByWorkspaceId(req.workspaceId);
  res.json({ ok: true, cleared: count });
});

router.delete("/data/healing", requireRole("admin"), (req, res) => {
  const projectIds = projectRepo.getAllIncludeDeleted(req.workspaceId).map((p) => p.id);
  const testIds = testRepo.getAllIdsByProjectIdsIncludeDeleted(projectIds);
  const count = healingRepo.countByTestIds(testIds);
  healingRepo.deleteByTestIds(testIds);
  logActivity({ ...actor(req), type: "settings.update", detail: `Cleared ${count} healing history entries` });
  res.json({ ok: true, cleared: count });
});

export default router;
