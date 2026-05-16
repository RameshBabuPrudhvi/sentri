/**
 * @module pages/AuditLog
 * @description SEC-007 compliance audit log — admin-only, workspace-scoped,
 * tamper-evident chronological feed of every action taken across the
 * workspace, grouped by calendar day.
 *
 * ### Data source
 * Backed by `GET /api/v1/workspaces/:workspaceId/audit-log` (admin-only,
 * cursor-paginated). Every read fires a meta-audit `audit.read` row on the
 * server (`audit.export` for CSV / NDJSON) per PCI-DSS 10.2.6 + SOC 2 CC7.2,
 * so this page deliberately does NOT fall back to `api.getActivities` —
 * that would split the meta-audit trail and make exfiltration invisible.
 *
 * ### Features
 * - Stats strip: events today, approvals 7 d (auto / human), revokes 7 d
 *   (read in one paginated batch from the same compliance endpoint).
 * - Free-text search (debounced 300 ms) — client-side filter on the
 *   currently-loaded page.
 * - Event-type chip filter (all / approve / reject / bulk / create / auth / other).
 * - Project dropdown + sort selector (URL-driven).
 * - Cursor-based "Load more" — opaque cursor from `nextCursor` so
 *   concurrent writes don't shift the page window.
 * - Server-side CSV / NDJSON export with `Content-Disposition: attachment`.
 *   Backend rate-limits exports at 10 / 15 min per (workspace × admin).
 * - "Verify chain" admin action — calls `GET /audit/verify`, shows result
 *   inline. No-op when `AUDIT_HASH_CHAIN` is unset on the server.
 * - DLQ inspector — lists SIEM dead-letter rows with per-row "Replay" and
 *   handles the pre-Part-C `503 SIEM_NOT_CONFIGURED` cleanly.
 *
 * ### Role access
 * Admin-only at both the route (`<ProtectedRoute requiredRole="admin">`)
 * and the backend (`requireRole("admin")`) layers. Defence-in-depth: even
 * if a future bug bypasses the route guard, the backend still refuses.
 */

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { API_PATH } from "../utils/apiBase.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useNotifications } from "../context/NotificationContext.jsx";
import { ACTIVITY_TYPES } from "../constants/activityTypes.js";
import { fmtDateTime, fmtDate } from "../utils/formatters.js";
import "../styles/pages/audit-log.css";

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

/**
 * Event-type chip definitions.
 * `types` maps to the ACTIVITY_TYPES values sent as the `type` query param.
 * `null` means "all events" (no type filter).
 */
const TYPE_CHIPS = [
  { key: "all",     label: "All events",  types: null },
  {
    key: "approve",
    label: "Approvals",
    types: [ACTIVITY_TYPES.TEST_APPROVE, ACTIVITY_TYPES.TEST_AUTO_APPROVE],
  },
  {
    key: "reject",
    label: "Rejections",
    types: [ACTIVITY_TYPES.TEST_REJECT],
  },
  {
    key: "revoke",
    label: "Revokes",
    types: [ACTIVITY_TYPES.TEST_REVOKE],
  },
  {
    key: "bulk",
    label: "Bulk actions",
    types: [
      ACTIVITY_TYPES.TEST_BULK_APPROVE,
      ACTIVITY_TYPES.TEST_BULK_REJECT,
      ACTIVITY_TYPES.TEST_BULK_RESTORE,
      ACTIVITY_TYPES.TEST_BULK_DELETE,
    ],
  },
  {
    key: "create",
    label: "Generated",
    types: [ACTIVITY_TYPES.TEST_GENERATE, ACTIVITY_TYPES.TEST_CREATE],
  },
  {
    key: "auth",
    label: "Auth",
    // SEC-007: surface the 8 password-path auth events + meta-audit reads
    // so SOC 2 reviewers can filter the entire authentication trail in
    // one click. `AUDIT_*` types appear here too because they're emitted
    // by the audit-log route itself (audit-of-audit).
    types: [
      ACTIVITY_TYPES.AUTH_LOGIN,
      ACTIVITY_TYPES.AUTH_LOGIN_FAILED,
      ACTIVITY_TYPES.AUTH_LOGOUT,
      ACTIVITY_TYPES.AUTH_PASSWORD_RESET,
      ACTIVITY_TYPES.AUTH_ROLE_CHANGE,
      ACTIVITY_TYPES.AUTH_API_KEY_CREATE,
      ACTIVITY_TYPES.AUTH_API_KEY_REVOKE,
      ACTIVITY_TYPES.AUTH_SESSION_REVOKE,
      ACTIVITY_TYPES.AUDIT_READ,
      ACTIVITY_TYPES.AUDIT_EXPORT,
    ],
  },
  {
    key: "other",
    label: "Other",
    types: [
      ACTIVITY_TYPES.TEST_EDIT,
      ACTIVITY_TYPES.TEST_DELETE,
      ACTIVITY_TYPES.TEST_REGENERATE,
      ACTIVITY_TYPES.TEST_RESTORE,
    ],
  },
];

// ─── Entry display helpers ────────────────────────────────────────────────────

/**
 * Map an activity type to its badge variant and human-readable label.
 * Returns `{ badgeClass, label, icon }`.
 *
 * @param {string} type — `activities.type` value
 * @returns {{ badgeClass: string, label: string }}
 */
function entryMeta(type) {
  switch (type) {
    case ACTIVITY_TYPES.TEST_APPROVE:
      return { badgeClass: "badge-green",  label: "Approved" };
    case ACTIVITY_TYPES.TEST_AUTO_APPROVE:
      return { badgeClass: "badge-green",  label: "Auto-approved" };
    case ACTIVITY_TYPES.TEST_REJECT:
      return { badgeClass: "badge-red",    label: "Rejected" };
    case ACTIVITY_TYPES.TEST_REVOKE:
      return { badgeClass: "badge-amber",  label: "Revoked" };
    case ACTIVITY_TYPES.TEST_RESTORE:
      return { badgeClass: "badge-blue",   label: "Restored" };
    case ACTIVITY_TYPES.TEST_BULK_APPROVE:
      return { badgeClass: "badge-green",  label: "Bulk approved" };
    case ACTIVITY_TYPES.TEST_BULK_REJECT:
      return { badgeClass: "badge-red",    label: "Bulk rejected" };
    case ACTIVITY_TYPES.TEST_BULK_RESTORE:
      return { badgeClass: "badge-blue",   label: "Bulk restored" };
    case ACTIVITY_TYPES.TEST_BULK_DELETE:
      return { badgeClass: "badge-gray",   label: "Bulk deleted" };
    case ACTIVITY_TYPES.TEST_GENERATE:
    case ACTIVITY_TYPES.TEST_CREATE:
      return { badgeClass: "badge-accent", label: "Generated" };
    case ACTIVITY_TYPES.TEST_EDIT:
      return { badgeClass: "badge-gray",   label: "Edited" };
    case ACTIVITY_TYPES.TEST_DELETE:
      return { badgeClass: "badge-red",    label: "Deleted" };
    case ACTIVITY_TYPES.TEST_REGENERATE:
      return { badgeClass: "badge-accent", label: "Regenerated" };
    // SEC-007 auth-events surface. Distinct colours so SOC 2 reviewers can
    // visually scan a busy feed and spot failed logins / role changes
    // without reading the type literal.
    case ACTIVITY_TYPES.AUTH_LOGIN:
      return { badgeClass: "badge-blue",   label: "Sign-in" };
    case ACTIVITY_TYPES.AUTH_LOGIN_FAILED:
      return { badgeClass: "badge-red",    label: "Sign-in failed" };
    case ACTIVITY_TYPES.AUTH_LOGOUT:
      return { badgeClass: "badge-gray",   label: "Sign-out" };
    case ACTIVITY_TYPES.AUTH_PASSWORD_RESET:
      return { badgeClass: "badge-amber",  label: "Password reset" };
    case ACTIVITY_TYPES.AUTH_ROLE_CHANGE:
      return { badgeClass: "badge-amber",  label: "Role changed" };
    case ACTIVITY_TYPES.AUTH_API_KEY_CREATE:
      return { badgeClass: "badge-blue",   label: "API key created" };
    case ACTIVITY_TYPES.AUTH_API_KEY_REVOKE:
      return { badgeClass: "badge-amber",  label: "API key revoked" };
    case ACTIVITY_TYPES.AUTH_SESSION_REVOKE:
      return { badgeClass: "badge-amber",  label: "Session revoked" };
    case ACTIVITY_TYPES.AUDIT_READ:
      return { badgeClass: "badge-gray",   label: "Audit read" };
    case ACTIVITY_TYPES.AUDIT_EXPORT:
      return { badgeClass: "badge-amber",  label: "Audit export" };
    default:
      return { badgeClass: "badge-gray",   label: type ?? "—" };
  }
}

/**
 * Group an array of activity rows by their calendar date string.
 *
 * @param {object[]} rows
 * @returns {Array<{ dateKey: string, label: string, items: object[] }>}
 */
function groupByDay(rows) {
  const groups = [];
  let currentKey = null;

  for (const row of rows) {
    const d = new Date(row.createdAt);
    const key = d.toDateString();

    if (key !== currentKey) {
      currentKey = key;
      const now = new Date();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);

      let label;
      if (key === now.toDateString()) {
        label = "Today";
      } else if (key === yesterday.toDateString()) {
        label = "Yesterday";
      } else {
        label = fmtDate(row.createdAt);
      }

      groups.push({ dateKey: key, label, items: [] });
    }

    groups[groups.length - 1].items.push(row);
  }

  return groups;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Single activity row inside a day group.
 *
 * @param {{ entry: object }} props
 */
function ActivityEntry({ entry }) {
  const { badgeClass, label } = entryMeta(entry.type);
  const time = fmtDateTime(entry.createdAt);
  const score = entry.meta?.score;
  const wasAuto = entry.meta?.wasAutoApproved;

  return (
    <div className="al-entry">
      <div className="al-entry__left">
        {/* Event badge */}
        <span className={`badge ${badgeClass} al-entry__badge`}>{label}</span>

        {/* Test name + project */}
        <div className="al-entry__body">
          <span className="al-entry__test-name">
            {entry.testName || entry.detail || "—"}
          </span>
          {entry.projectName && (
            <span className="al-entry__project">{entry.projectName}</span>
          )}
        </div>
      </div>

      <div className="al-entry__right">
        {/* Confidence score (auto-approvals) */}
        {score != null && (
          <span className="al-entry__score">
            {Number(score).toFixed(2)}
          </span>
        )}

        {/* wasAutoApproved flag on revoke rows */}
        {wasAuto && (
          <span className="badge badge-amber al-entry__was-auto">was auto</span>
        )}

        {/* Actor + IP (SEC-007: session-reconstruction evidence). The IP is
            rendered as a `title` on the actor so a SOC 2 reviewer can hover
            for the full {IP, user-agent} pair without cluttering the row. */}
        {entry.userName && (
          <span
            className="al-entry__actor"
            title={entry.ipAddress ? `${entry.ipAddress}${entry.userAgent ? ` · ${entry.userAgent}` : ""}` : undefined}
          >
            {entry.userName}
          </span>
        )}

        {/* Timestamp */}
        <time
          className="al-entry__time"
          dateTime={entry.createdAt}
          title={entry.createdAt}
        >
          {time}
        </time>
      </div>
    </div>
  );
}

/**
 * Day group header + its activity rows.
 *
 * @param {{ label: string, items: object[] }} props
 */
function DayGroup({ label, items }) {
  return (
    <div className="al-day-group">
      <div className="al-day-group__label">
        <span>{label}</span>
        <span className="al-day-group__count">{items.length}</span>
      </div>
      {items.map((entry) => (
        <ActivityEntry key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AuditLog() {
  const { user } = useAuth();
  // Admin-gated at the route layer (frontend/src/App.jsx:71) AND by the
  // backend (`requireRole("admin")`). The workspaceId comes from the JWT
  // claim baked into `user` at login — never from URL state.
  const workspaceId = user?.workspaceId;
  const { addNotification } = useNotifications();

  // ── URL-driven filters (mirrors ReviewQueue + ApprovalsTimeline pattern) ──
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId") || "all";
  const sortOrder = searchParams.get("sort")    || "newest";

  function setParam(key, value) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (!value || value === "all" || value === "newest") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      return next;
    }, { replace: true });
  }

  // ── Local state ───────────────────────────────────────────────────────────
  const [typeKey, setTypeKey]   = useState("all");
  const [q, setQ]               = useState("");
  const [debouncedQ, setDQ]     = useState("");
  const [projects, setProjects] = useState([]);
  const [rows, setRows]         = useState([]);
  // SEC-007: cursor pagination. `cursor` is an opaque ISO timestamp from
  // the server's `nextCursor` field. `null` (or empty string) means "no
  // more pages" / "start from the top". Replaces the legacy offset counter
  // so concurrent INSERTs don't shift the window between page fetches.
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]       = useState(null);
  const [stats, setStats]       = useState(null);

  // ── Hash-chain verify state (SEC-007) ──────────────────────────────────────
  // `null`         — never run / chain disabled state not yet known
  // { verified }   — last verify result; rendered as an inline banner
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifying, setVerifying]       = useState(false);

  // ── DLQ inspector state (SEC-007) ──────────────────────────────────────────
  // Lazy-loaded — only fetched when the panel is opened. `null` means
  // "panel never opened". Empty array means "panel opened, zero rows".
  const [dlqRows, setDlqRows] = useState(null);
  const [dlqOpen, setDlqOpen] = useState(false);
  const [dlqLoading, setDlqLoading] = useState(false);
  const [replayingId, setReplayingId] = useState(null);

  // ── Stats ─────────────────────────────────────────────────────────────────
  // SEC-007: read stats from the same compliance endpoint as the main feed
  // (not the legacy /activities route) so every byte goes through the same
  // workspace-scope assertion, meta-audit, and rate-limiter. The page's two
  // batches are bucketed under one `audit.read` row on the server — which
  // is the SOC 2 / PCI-DSS-correct way to attribute the access.
  //
  // Fetched independent of the active project / type filters so the strip
  // shows workspace-wide totals (a SOC-2 reviewer wants the workspace
  // health, not the currently-filtered slice).
  useEffect(() => {
    if (!workspaceId) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    Promise.all([
      api.getWorkspaceAuditLog(workspaceId, { dateFrom: today.toISOString(),       limit: 500 }),
      api.getWorkspaceAuditLog(workspaceId, { dateFrom: sevenDaysAgo.toISOString(), limit: 1000 }),
    ])
      .then(([todayRes, weekRes]) => {
        const todayArr  = Array.isArray(todayRes?.rows) ? todayRes.rows : [];
        const weekArr   = Array.isArray(weekRes?.rows)  ? weekRes.rows  : [];
        setStats({
          eventsToday:  todayArr.length,
          autoApprove7d:  weekArr.filter(r => r.type === ACTIVITY_TYPES.TEST_AUTO_APPROVE).length,
          humanApprove7d: weekArr.filter(r => r.type === ACTIVITY_TYPES.TEST_APPROVE).length,
          revoked7d:      weekArr.filter(r => r.type === ACTIVITY_TYPES.TEST_REVOKE).length,
        });
      })
      .catch(() => {}); // stats strip is non-critical; main feed shows the real error
  }, [workspaceId]);

  // ── Projects list for dropdown ─────────────────────────────────────────────
  useEffect(() => {
    api.getProjects()
      .then((data) => setProjects(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  // ── Debounce search (300 ms — mirrors ReviewQueue) ─────────────────────────
  const debounceRef = useRef(null);
  function handleSearch(val) {
    setQ(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDQ(val);
    }, 300);
  }

  // ── Build filter params for the compliance API call ────────────────────────
  const chip = TYPE_CHIPS.find((c) => c.key === typeKey) ?? TYPE_CHIPS[0];
  // SEC-007: the compliance endpoint accepts `type` as a repeatable param,
  // so we pass the full array in one round-trip — no per-type fan-out, no
  // client-side merge. `null` (the "all" chip) means "no type filter".
  const filterTypes = chip.types; // null | string[]

  // Shared client-side text filter — applied to the currently-loaded page.
  // The compliance endpoint has no `q` param yet (a future enhancement);
  // for now we filter the rendered rows locally on testName, detail,
  // userName, projectName, ipAddress, and the activity type itself.
  const applyTextFilter = useCallback((arr) => {
    if (!debouncedQ) return arr;
    const lq = debouncedQ.toLowerCase();
    return arr.filter((r) =>
      (r.testName    || "").toLowerCase().includes(lq) ||
      (r.detail      || "").toLowerCase().includes(lq) ||
      (r.userName    || "").toLowerCase().includes(lq) ||
      (r.projectName || "").toLowerCase().includes(lq) ||
      (r.ipAddress   || "").toLowerCase().includes(lq) ||
      (r.type        || "").toLowerCase().includes(lq),
    );
  }, [debouncedQ]);

  // ── Main fetch (cursor-paginated, workspace-scoped) ────────────────────────
  // Refetch on filter change. Cursor is reset (start from the top); next
  // pages come from `loadMore` below using the server's `nextCursor`.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const filters = {
      projectId: projectId !== "all" ? projectId : undefined,
      type: filterTypes || undefined,
      limit: PAGE_SIZE,
    };

    api.getWorkspaceAuditLog(workspaceId, filters)
      .then((res) => {
        if (cancelled) return;
        let fetched = Array.isArray(res?.rows) ? res.rows : [];
        fetched = applyTextFilter(fetched);
        if (sortOrder === "oldest") fetched = [...fetched].reverse();
        setRows(fetched);
        setNextCursor(res?.nextCursor || null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        // AGENT.md: surface the user-facing message; the backend wraps 5xx
        // errors with stable codes (AUDIT_READ_FAILED) the UI could branch
        // on later, but the message field is already sanitised.
        setError(err.message || "Failed to load audit log");
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [workspaceId, typeKey, projectId, sortOrder, debouncedQ, applyTextFilter, filterTypes]);

  // ── Load more (cursor-paginated) ───────────────────────────────────────────
  async function loadMore() {
    if (loadingMore || !nextCursor || !workspaceId) return;
    setLoadingMore(true);
    try {
      const filters = {
        projectId: projectId !== "all" ? projectId : undefined,
        type: filterTypes || undefined,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      };
      const res = await api.getWorkspaceAuditLog(workspaceId, filters);
      let fetched = Array.isArray(res?.rows) ? res.rows : [];
      fetched = applyTextFilter(fetched);
      if (sortOrder === "oldest") fetched = [...fetched].reverse();
      setRows((prev) => [...prev, ...fetched]);
      setNextCursor(res?.nextCursor || null);
    } catch (err) {
      addNotification({ type: "error", message: err.message || "Failed to load more" });
    } finally {
      setLoadingMore(false);
    }
  }

  // ── Server-side export (CSV / NDJSON) ──────────────────────────────────────
  // SEC-007: triggers a server-rendered export via the compliance endpoint.
  // The server applies the same filter shape we're currently viewing, writes
  // a meta-audit `audit.export` row, and the response carries
  // `Content-Disposition: attachment` so the browser saves to disk. The
  // backend rate-limits exports at 10 / 15 min per (workspace × admin) —
  // 429 responses are surfaced as a notification with the friendly error
  // message returned by the limiter.
  //
  // We DON'T use the JSON `api.exportWorkspaceAuditLog` helper because that
  // would try to parse the CSV/NDJSON response as JSON. Instead we build the
  // URL and fetch as a blob — the same pattern as `api.downloadExport`.
  async function handleExport(format /* "csv" | "ndjson" */) {
    if (!workspaceId) return;
    const params = new URLSearchParams();
    params.set("format", format);
    if (projectId !== "all") params.set("projectId", projectId);
    if (filterTypes) filterTypes.forEach((t) => params.append("type", t));
    if (debouncedQ) {
      // The server has no `q` param yet; document the limitation in the
      // notification so an evidence-pulling admin knows the file matches
      // the filter chips, not the search box.
      addNotification({
        type: "info",
        message: "Export ignores the search box (server-side filter applies the type/project/date chips only).",
      });
    }
    const url = `${API_PATH}/workspaces/${workspaceId}/audit-log?${params.toString()}`;
    try {
      const res = await fetch(url, { credentials: "include" });
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        addNotification({
          type: "error",
          message: body.error || "Too many audit-log exports. Try again later.",
        });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        addNotification({
          type: "error",
          message: body.error || `Export failed (${res.status}).`,
        });
        return;
      }
      const blob = await res.blob();
      const date = new Date().toISOString().slice(0, 10);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `sentri-audit-log-${date}.${format}`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
    } catch (err) {
      addNotification({ type: "error", message: err.message || "Export failed." });
    }
  }

  // ── Hash-chain verify (SEC-007) ────────────────────────────────────────────
  // Calls `GET /api/v1/audit/verify`. Result shapes:
  //   { verified: true,  chainDisabled: true }  — AUDIT_HASH_CHAIN unset
  //   { verified: true,  total }                — clean walk
  //   { verified: false, firstBrokenRowId, total } — tamper detected
  async function handleVerify() {
    if (verifying) return;
    setVerifying(true);
    try {
      const res = await api.verifyAuditChain();
      setVerifyResult(res);
    } catch (err) {
      addNotification({ type: "error", message: err.message || "Verification failed." });
    } finally {
      setVerifying(false);
    }
  }

  // ── DLQ inspector (SEC-007) ────────────────────────────────────────────────
  async function openDlq() {
    if (!workspaceId) return;
    setDlqOpen(true);
    if (dlqRows !== null) return; // already loaded
    setDlqLoading(true);
    try {
      const res = await api.listAuditDlq(workspaceId, { limit: 200 });
      setDlqRows(Array.isArray(res?.rows) ? res.rows : []);
    } catch (err) {
      addNotification({ type: "error", message: err.message || "Failed to load DLQ." });
      setDlqRows([]);
    } finally {
      setDlqLoading(false);
    }
  }

  async function handleReplay(dlqId) {
    if (replayingId || !workspaceId) return;
    setReplayingId(dlqId);
    try {
      await api.replayAuditDlq(workspaceId, dlqId);
      addNotification({ type: "success", message: "DLQ entry replayed." });
      setDlqRows((prev) => (prev || []).filter((r) => r.id !== dlqId));
    } catch (err) {
      // SIEM forwarder is shipped in Part C — pre-then this returns
      // 503 SIEM_NOT_CONFIGURED. Surface that distinctly from real
      // dispatch failures so the admin knows it's a server config gap,
      // not a SIEM outage.
      const code = err.body?.code;
      if (code === "SIEM_NOT_CONFIGURED") {
        addNotification({
          type: "info",
          message: "SIEM forwarding isn't configured on this server yet (Part C).",
        });
      } else {
        addNotification({ type: "error", message: err.message || "Replay failed." });
      }
    } finally {
      setReplayingId(null);
    }
  }

  // ── Grouped rows ───────────────────────────────────────────────────────────
  const groups = useMemo(() => groupByDay(rows), [rows]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="al-page page-container">

      {/* ── Header ── */}
      <div className="page-header al-header">
        <div>
          <h1 className="page-title">Audit log</h1>
          <p className="page-subtitle">
            Workspace compliance trail · Immutable · Admin only
          </p>
        </div>
        <div className="al-header__actions">
          {/* Hash-chain verify — admin gesture so a SOC 2 reviewer can ask
              "is the audit log intact?" from the UI rather than the CLI. */}
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleVerify}
            disabled={verifying}
            title="Walk the prevHash chain and report tampering"
          >
            {verifying ? "Verifying…" : "Verify chain"}
          </button>
          {/* DLQ inspector — opens the SIEM dead-letter panel below. */}
          <button
            className="btn btn-ghost btn-sm"
            onClick={openDlq}
            title="Inspect SIEM dead-letter queue"
          >
            DLQ{dlqRows && dlqRows.length > 0 ? ` (${dlqRows.length})` : ""}
          </button>
          {/* Server-side exports — meta-audited + rate-limited (10/15min). */}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => handleExport("csv")}
            disabled={rows.length === 0}
          >
            Export CSV
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => handleExport("ndjson")}
            disabled={rows.length === 0}
          >
            Export NDJSON
          </button>
        </div>
      </div>

      {/* ── Hash-chain verify result banner ── */}
      {verifyResult && (
        <div
          className={`banner ${
            verifyResult.verified
              ? "banner-success"
              : "banner-error"
          }`}
          role="status"
        >
          {verifyResult.chainDisabled
            ? "Hash chain is disabled on this server (set AUDIT_HASH_CHAIN=true to enable tamper-evidence)."
            : verifyResult.verified
              ? `✓ Chain verified · ${verifyResult.total} rows`
              : `✗ Chain broken at row ${verifyResult.firstBrokenRowId} (${verifyResult.total} rows scanned)`}
        </div>
      )}

      {/* ── DLQ inspector panel ── */}
      {dlqOpen && (
        <div className="card card-padded-sm al-dlq" role="region" aria-label="SIEM dead-letter queue">
          <div className="al-dlq__header">
            <strong>SIEM dead-letter queue</strong>
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => setDlqOpen(false)}
              aria-label="Close DLQ panel"
            >
              ✕
            </button>
          </div>
          {dlqLoading && <div className="al-dlq__empty">Loading…</div>}
          {!dlqLoading && dlqRows !== null && dlqRows.length === 0 && (
            <div className="al-dlq__empty">No failed dispatches.</div>
          )}
          {!dlqLoading && dlqRows && dlqRows.length > 0 && (
            <table className="al-dlq__table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Created</th>
                  <th>Attempts</th>
                  <th>Last error</th>
                  <th aria-label="Actions"></th>
                </tr>
              </thead>
              <tbody>
                {dlqRows.map((r) => (
                  <tr key={r.id}>
                    <td><code>{r.id}</code></td>
                    <td>{fmtDateTime(r.createdAt)}</td>
                    <td>{r.attempts}</td>
                    <td className="al-dlq__error" title={r.lastError}>{r.lastError}</td>
                    <td>
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => handleReplay(r.id)}
                        disabled={replayingId === r.id}
                      >
                        {replayingId === r.id ? "Replaying…" : "Replay"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Stats strip ── */}
      <div className="stat-grid al-stats">
        <div className="card card-padded-sm">
          <div className="section-label">Events today</div>
          <div className="al-stat__value">
            {stats ? stats.eventsToday : <span className="al-stat__skeleton" />}
          </div>
        </div>
        <div className="card card-padded-sm">
          <div className="section-label">Auto-approved (7 d)</div>
          <div className="al-stat__value">
            {stats ? stats.autoApprove7d : <span className="al-stat__skeleton" />}
          </div>
        </div>
        <div className="card card-padded-sm">
          <div className="section-label">Human-approved (7 d)</div>
          <div className="al-stat__value">
            {stats ? stats.humanApprove7d : <span className="al-stat__skeleton" />}
          </div>
        </div>
        <div className="card card-padded-sm">
          <div className="section-label">Revoked (7 d)</div>
          <div className="al-stat__value">
            {stats ? stats.revoked7d : <span className="al-stat__skeleton" />}
          </div>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="al-toolbar">
        {/* Search */}
        <div className="al-toolbar__search">
          <input
            className="input"
            type="search"
            placeholder="Search tests, users…"
            value={q}
            onChange={(e) => handleSearch(e.target.value)}
            aria-label="Search audit log"
          />
        </div>

        {/* Project filter — refetch driven by useEffect on projectId change.
            No explicit row-reset needed; the effect resets the cursor and
            replaces `rows` with the first page atomically. */}
        <select
          className="input al-toolbar__select"
          value={projectId}
          onChange={(e) => setParam("projectId", e.target.value)}
          aria-label="Filter by project"
        >
          <option value="all">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        {/* Sort */}
        <select
          className="input al-toolbar__select"
          value={sortOrder}
          onChange={(e) => setParam("sort", e.target.value)}
          aria-label="Sort order"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>

      {/* ── Type chips ── */}
      <div className="al-chips" role="group" aria-label="Filter by event type">
        {TYPE_CHIPS.map((chip) => (
          <button
            key={chip.key}
            className={`btn btn-xs al-chip${typeKey === chip.key ? " al-chip--active" : ""}`}
            onClick={() => setTypeKey(chip.key)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* ── Feed ── */}
      {loading && (
        <div className="al-loading">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="al-entry al-entry--skeleton">
              <div className="al-entry__skeleton-badge" />
              <div className="al-entry__skeleton-body" />
              <div className="al-entry__skeleton-time" />
            </div>
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="banner banner-error">{error}</div>
      )}

      {!loading && !error && groups.length === 0 && (
        <div className="al-empty">
          <div className="al-empty__icon">📋</div>
          <div className="al-empty__title">No events found</div>
          <p className="al-empty__desc">
            {debouncedQ || typeKey !== "all" || projectId !== "all"
              ? "Try adjusting your filters."
              : "Workspace activity will appear here as your team takes actions."}
          </p>
        </div>
      )}

      {!loading && !error && groups.length > 0 && (
        <div className="al-feed">
          {groups.map((g) => (
            <DayGroup key={g.dateKey} label={g.label} items={g.items} />
          ))}

          {/* Load more — visible only while the server says there's a next
              page. The cursor is opaque (an ISO timestamp internally) so
              the UI doesn't reason about it directly. */}
          {nextCursor && (
            <div className="al-load-more">
              <button
                className="btn btn-ghost btn-sm"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}

    </div>
  );
}