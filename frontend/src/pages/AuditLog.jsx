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
// audit-log.css is imported from `frontend/src/index.css` after
// approvals-timeline.css, so the ITCSS cascade order is guaranteed.

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
      // SEC-007: `audit.purge` is the most security-critical admin action
      // (truncating the compliance log) — grouped under "Auth" alongside the
      // other meta-audit types so PCI-DSS 10.2.6 reviewers see every audit-
      // trail event in one filter click, not only when "All events" is on.
      ACTIVITY_TYPES.AUDIT_PURGE,
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
    case ACTIVITY_TYPES.AUDIT_PURGE:
      // Red — purging the compliance trail is the most destructive admin
      // action in the system; reviewers must spot it at a glance.
      return { badgeClass: "badge-red",    label: "Audit purge" };
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
/**
 * SEC-007: derive a human-readable description for activity rows that
 * have no `testName`/`detail` but DO carry useful structured `meta`.
 * Without this, the audit log feed renders "—" for every meta-audit row
 * (`audit.read`, `audit.export`, `audit.purge`) and every auth event —
 * dominating the feed with placeholder text instead of the filter shape
 * / event context a SOC 2 reviewer actually needs.
 *
 * Returns null when the row has no row-specific context worth summarising;
 * the caller renders the existing "—" fallback.
 *
 * @param {Object} entry — activity row
 * @returns {string|null}
 */
function describeMetaAuditEntry(entry) {
  const meta = entry.meta || {};
  switch (entry.type) {
    case ACTIVITY_TYPES.AUDIT_READ:
    case ACTIVITY_TYPES.AUDIT_EXPORT: {
      // `meta.filters` carries the full filter shape the route handler
      // captured. Surface the most meaningful slice: format, row count,
      // and any non-null filter.
      const fmt = meta.format || "json";
      const count = typeof meta.rowCount === "number" ? `${meta.rowCount} rows` : "";
      const f = meta.filters || {};
      const activeFilters = [];
      if (f.userId) activeFilters.push(`user=${f.userId}`);
      if (f.projectId) activeFilters.push(`project=${f.projectId}`);
      if (Array.isArray(f.types) && f.types.length) activeFilters.push(`types=${f.types.join(",")}`);
      if (f.dateFrom) activeFilters.push(`from=${f.dateFrom.slice(0, 10)}`);
      if (f.dateTo) activeFilters.push(`to=${f.dateTo.slice(0, 10)}`);
      if (f.ipAddress) activeFilters.push(`ip=${f.ipAddress}`);
      const parts = [fmt.toUpperCase(), count, activeFilters.join(" · ")].filter(Boolean);
      return parts.join(" · ") || null;
    }
    case ACTIVITY_TYPES.AUDIT_PURGE:
      return meta.cleared != null
        ? `Cleared ${meta.cleared} activity row(s)`
        : "Audit log truncated";
    case ACTIVITY_TYPES.AUTH_LOGIN:
    case ACTIVITY_TYPES.AUTH_LOGIN_FAILED:
    case ACTIVITY_TYPES.AUTH_LOGOUT:
    case ACTIVITY_TYPES.AUTH_PASSWORD_RESET:
      // userName already shown in the actor column; nothing extra to add
      // unless the route added a `reason` (e.g. session.revoke).
      return null;
    case ACTIVITY_TYPES.AUTH_ROLE_CHANGE:
      return (meta.from && meta.to)
        ? `${meta.from} → ${meta.to}`
        : null;
    case ACTIVITY_TYPES.AUTH_API_KEY_CREATE:
    case ACTIVITY_TYPES.AUTH_API_KEY_REVOKE:
      return meta.provider
        ? `Provider: ${meta.providerName || meta.provider}`
        : null;
    case ACTIVITY_TYPES.AUTH_SESSION_REVOKE:
      return meta.reason ? `Reason: ${meta.reason}` : null;
    default:
      return null;
  }
}

function ActivityEntry({ entry }) {
  const { badgeClass, label } = entryMeta(entry.type);
  const time = fmtDateTime(entry.createdAt);
  const score = entry.meta?.score;
  const wasAuto = entry.meta?.wasAutoApproved;
  // SEC-007: many audit rows (`audit.read`, `audit.role.change`, etc.) have
  // no `testName` or `detail` because they're not test-scoped — but they
  // DO carry structured `meta`. Without this, the feed renders "—" for
  // every such row and looks empty. Falls back to "—" only when no useful
  // context exists.
  const metaDescription = describeMetaAuditEntry(entry);

  return (
    <div className="al-entry">
      <div className="al-entry__left">
        {/* Event badge */}
        <span className={`badge ${badgeClass} al-entry__badge`}>{label}</span>

        {/* Test name + project + meta-derived context */}
        <div className="al-entry__body">
          <span className="al-entry__test-name">
            {entry.testName || entry.detail || metaDescription || "—"}
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

  // ── System security events (SEC-007) ────────────────────────────────────────
  // Cross-tenant deployment-wide events with workspaceId = SYSTEM_WORKSPACE_ID
  // (chiefly auth.login.failed against unknown emails — credential-stuffing
  // probes that fire before a tenant can be resolved). Surfaced via a
  // dedicated admin-only panel rather than the workspace-scoped feed.
  const [sysEventsOpen, setSysEventsOpen] = useState(false);
  const [sysEventsRows, setSysEventsRows] = useState(null);
  const [sysEventsLoading, setSysEventsLoading] = useState(false);

  // ── SIEM config state (SEC-007 Part C) ─────────────────────────────────────
  // Lazy-loaded — only fetched when the panel is opened. `null` means
  // "panel never opened or no config exists yet".
  const [siemOpen, setSiemOpen] = useState(false);
  const [siemConfig, setSiemConfig] = useState(null);
  const [siemLoading, setSiemLoading] = useState(false);
  const [siemSaving, setSiemSaving] = useState(false);
  // Form state separate from `siemConfig` so the user can edit without
  // losing the persisted view, and so the masked hmacSecret (from the
  // server) doesn't get accidentally re-submitted as the literal masked
  // string. Empty hmacSecret on save = "keep existing"; non-empty = rotate.
  const [siemForm, setSiemForm] = useState({ targetUrl: "", hmacSecret: "", headersJson: "", enabled: true });
  const [siemError, setSiemError] = useState(null);

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
        // SEC-007: do NOT apply the text filter here. The filter is a
        // client-side render-time concern (see `applyTextFilter` below and
        // the `groupByDay` useMemo). Applying it pre-`setRows` would force
        // this effect's dep array to include `debouncedQ`, which would
        // trigger a full server round-trip on every keystroke and emit a
        // spurious `audit.read` meta-audit row per keystroke — polluting
        // the PCI-DSS 10.2.6 compliance trail with reads that never
        // happened. Server fetches now depend ONLY on server-side filter
        // shape (type, project, sort).
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
    // INTENTIONAL: `debouncedQ` and `applyTextFilter` are NOT in this deps
    // array. The search is render-time only (see `filteredRows` useMemo).
    // Including them here would trigger a server fetch (and a meta-audit
    // `audit.read` row) on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, typeKey, projectId, sortOrder, filterTypes]);

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
      // SEC-007: the text filter is applied at render time (see
      // `filteredRows` useMemo below), NOT here. Filtering pre-`setRows`
      // would discard server rows that don't match the current search and
      // permanently remove them from the cursor stream — typing then
      // clearing the search would leave gaps in the loaded data.
      // The server always returns newest-first and the cursor walks
      // strictly older. In oldest-first display order the next page is
      // therefore older than every row already on screen — prepend it (in
      // chronological order, after the local reverse) so the timeline
      // stays monotonic and `groupByDay` keeps producing contiguous day
      // headers. Appending here would interleave a chunk of older rows
      // *after* newer ones and shatter the day grouping.
      //
      // INVARIANT — this only works because the INITIAL fetch (above)
      // also does `fetched = [...fetched].reverse()` in oldest-mode, so
      // `prev` is already oldest-first. If the initial sort ever changes,
      // update both branches together or this prepend will produce a
      // non-monotonic sequence. Dev-mode guard makes a regression loud
      // rather than silently rendering broken day groups.
      if (sortOrder === "oldest") {
        fetched = [...fetched].reverse();
        if (process.env.NODE_ENV !== "production" && rows.length > 0 && fetched.length > 0) {
          const prevOldest = rows[0]?.createdAt;
          const fetchedNewest = fetched[fetched.length - 1]?.createdAt;
          if (prevOldest && fetchedNewest && fetchedNewest >= prevOldest) {
            console.warn("[AuditLog] loadMore oldest-mode invariant violated — page boundaries overlap; day groups may render incorrectly.");
          }
        }
        setRows((prev) => [...fetched, ...prev]);
      } else {
        setRows((prev) => [...prev, ...fetched]);
      }
      setNextCursor(res?.nextCursor || null);
    } catch (err) {
      addNotification({ type: "error", title: "Audit log", body: err.message || "Failed to load more" });
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
        title: "Export",
        body: "Export ignores the search box (server-side filter applies the type/project/date chips only).",
      });
    }
    const url = `${API_PATH}/workspaces/${workspaceId}/audit-log?${params.toString()}`;
    try {
      const res = await fetch(url, { credentials: "include" });
      if (res.status === 429) {
        const errBody = await res.json().catch(() => ({}));
        addNotification({
          type: "error",
          title: "Export rate-limited",
          body: errBody.error || "Too many audit-log exports. Try again later.",
        });
        return;
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        addNotification({
          type: "error",
          title: "Export failed",
          body: errBody.error || `Export failed (${res.status}).`,
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
      addNotification({ type: "error", title: "Export failed", body: err.message || "Export failed." });
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
      addNotification({ type: "error", title: "Verify chain", body: err.message || "Verification failed." });
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
      addNotification({ type: "error", title: "DLQ", body: err.message || "Failed to load DLQ." });
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
      addNotification({ type: "success", title: "DLQ replay", body: "DLQ entry replayed." });
      setDlqRows((prev) => (prev || []).filter((r) => r.id !== dlqId));
    } catch (err) {
      // SIEM_NOT_CONFIGURED is distinct from real dispatch failures —
      // surface it as an info notification with a hint to configure
      // the forwarder. The "Configure SIEM" button lives in the same
      // header.
      const code = err.body?.code;
      if (code === "SIEM_NOT_CONFIGURED") {
        addNotification({
          type: "info",
          title: "SIEM not configured",
          body: "No SIEM target configured. Open SIEM config to set one.",
        });
      } else {
        addNotification({ type: "error", title: "DLQ replay", body: err.message || "Replay failed." });
      }
    } finally {
      setReplayingId(null);
    }
  }

  // ── System security events (SEC-007) ────────────────────────────────────────
  async function openSystemEvents() {
    setSysEventsOpen(true);
    if (sysEventsRows !== null) return; // already loaded
    setSysEventsLoading(true);
    try {
      const res = await api.getSystemSecurityEvents({ limit: 200 });
      setSysEventsRows(Array.isArray(res?.rows) ? res.rows : []);
    } catch (err) {
      addNotification({ type: "error", title: "System events", body: err.message || "Failed to load system events." });
      setSysEventsRows([]);
    } finally {
      setSysEventsLoading(false);
    }
  }

  // ── SIEM config handlers (SEC-007 Part C) ──────────────────────────────────
  async function openSiemConfig() {
    if (!workspaceId) return;
    setSiemOpen(true);
    if (siemConfig !== null) return; // already loaded (or no config exists)
    setSiemLoading(true);
    setSiemError(null);
    try {
      const res = await api.getWorkspaceSiemConfig(workspaceId);
      const cfg = res?.config || null;
      setSiemConfig(cfg);
      // Pre-fill the form from the persisted config, but leave
      // `hmacSecret` blank — the server returns it masked, and we don't
      // want the user accidentally re-submitting `••••••••abcd` as the
      // new secret. Empty hmacSecret on save = "keep existing".
      setSiemForm({
        targetUrl: cfg?.targetUrl || "",
        hmacSecret: "",
        headersJson: cfg?.headers ? JSON.stringify(cfg.headers, null, 2) : "",
        enabled: cfg?.enabled !== false,
      });
    } catch (err) {
      setSiemError(err.message || "Failed to load SIEM config.");
    } finally {
      setSiemLoading(false);
    }
  }

  async function handleSiemSave() {
    if (siemSaving || !workspaceId) return;
    setSiemError(null);

    // Validate form locally before round-trip.
    const targetUrl = (siemForm.targetUrl || "").trim();
    if (!targetUrl) {
      setSiemError("Target URL is required.");
      return;
    }
    // If there's no persisted config yet, hmacSecret is required.
    // If config exists, blank hmacSecret = "keep existing secret".
    // 32-char minimum matches NIST SP 800-107 (key length ≥ HMAC-SHA256
    // output length) — enforced by the backend PUT validator.
    if (!siemConfig && (!siemForm.hmacSecret || siemForm.hmacSecret.length < 32)) {
      setSiemError("HMAC secret is required and must be at least 32 characters.");
      return;
    }
    let parsedHeaders = null;
    if (siemForm.headersJson && siemForm.headersJson.trim()) {
      try {
        parsedHeaders = JSON.parse(siemForm.headersJson);
        if (typeof parsedHeaders !== "object" || Array.isArray(parsedHeaders)) {
          setSiemError("Headers must be a JSON object.");
          return;
        }
      } catch {
        setSiemError("Headers must be valid JSON.");
        return;
      }
    }

    setSiemSaving(true);
    try {
      // SEC-007: the backend PUT route accepts an omitted/empty `hmacSecret`
      // on UPDATE as "keep the existing encrypted secret". So we send the
      // field only when the user typed a new value; blank means "no rotation"
      // and the server reuses the stored blob. The insert-path validator
      // already enforces presence + 32-char minimum when no row exists.
      const payload = {
        targetUrl,
        headers: parsedHeaders,
        enabled: siemForm.enabled,
      };
      if (siemForm.hmacSecret && siemForm.hmacSecret.length > 0) {
        payload.hmacSecret = siemForm.hmacSecret;
      }
      const res = await api.upsertWorkspaceSiemConfig(workspaceId, payload);
      setSiemConfig(res?.config || null);
      // Clear the hmacSecret field after a successful save so it's not
      // hanging around in the DOM.
      setSiemForm((prev) => ({ ...prev, hmacSecret: "" }));
      addNotification({ type: "success", title: "SIEM config", body: "SIEM forwarder saved." });
    } catch (err) {
      setSiemError(err.message || "Failed to save SIEM config.");
    } finally {
      setSiemSaving(false);
    }
  }

  async function handleSiemDelete() {
    if (siemSaving || !workspaceId || !siemConfig) return;
    if (!window.confirm("Delete the SIEM forwarder configuration? Events will continue to land in the audit log but will not be pushed to your SIEM until you reconfigure.")) return;
    setSiemSaving(true);
    try {
      await api.deleteWorkspaceSiemConfig(workspaceId);
      setSiemConfig(null);
      setSiemForm({ targetUrl: "", hmacSecret: "", headersJson: "", enabled: true });
      addNotification({ type: "success", title: "SIEM config", body: "SIEM forwarder removed." });
    } catch (err) {
      setSiemError(err.message || "Failed to delete SIEM config.");
    } finally {
      setSiemSaving(false);
    }
  }

  // ── Filtered + grouped rows (render-time text filter) ─────────────────────
  // SEC-007: the search box filters the loaded page CLIENT-SIDE only — the
  // server has no `q` param yet, and including the search in the fetch deps
  // would emit a spurious `audit.read` meta-audit row per keystroke (see
  // the dep-array comment above). Filtering here keeps the trail clean and
  // gives the user instant feedback without a round-trip.
  const filteredRows = useMemo(
    () => applyTextFilter(rows),
    [rows, applyTextFilter],
  );
  const groups = useMemo(() => groupByDay(filteredRows), [filteredRows]);

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

          {/* DLQ inspector — opens the SIEM dead-letter panel below.
              Shows the unread count from `dlqRows` once the panel has been
              loaded at least once; matches the QA.md:1668 contract
              ("Click DLQ (0) in /audit-log header"). */}
          <button
            className="btn btn-ghost btn-sm"
            onClick={openDlq}
            title="Inspect SIEM dead-letter queue"
          >
            DLQ{dlqRows ? ` (${dlqRows.length})` : ""}
          </button>

          {/* System events — deployment-wide cross-tenant security events
              (workspaceId = SYSTEM_WORKSPACE_ID), chiefly auth.login.failed
              against unknown emails. Admin-only and explicitly cross-tenant
              per the backend `/system/security-events` route. */}
          <button
            className="btn btn-ghost btn-sm"
            onClick={openSystemEvents}
            title="Cross-tenant security events (auth probes, unknown-email failed logins)"
          >
            System events
          </button>

          {/* SIEM forwarder configuration — admin-only per-workspace. */}
          <button
            className="btn btn-ghost btn-sm"
            onClick={openSiemConfig}
            title="Configure SIEM forwarder (audit events → external SIEM)"
          >
            SIEM
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

      {/* ── System security events panel (SEC-007) ── */}
      {sysEventsOpen && (
        <div className="card card-padded-sm al-dlq" role="region" aria-label="System security events">
          <div className="al-dlq__header">
            <strong>System security events</strong>
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => setSysEventsOpen(false)}
              aria-label="Close system events panel"
            >
              ✕
            </button>
          </div>
          {sysEventsLoading && <div className="al-dlq__empty">Loading…</div>}
          {!sysEventsLoading && sysEventsRows !== null && sysEventsRows.length === 0 && (
            <div className="al-dlq__empty">No deployment-wide security events.</div>
          )}
          {!sysEventsLoading && sysEventsRows && sysEventsRows.length > 0 && (
            <table className="al-dlq__table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Email / user</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {sysEventsRows.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDateTime(r.createdAt)}</td>
                    <td><code>{r.type}</code></td>
                    <td>{r.userName || "—"}</td>
                    <td className="al-dlq__error" title={r.userAgent || ""}>{r.ipAddress || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── SIEM forwarder config panel (SEC-007 Part C) ── */}
      {siemOpen && (
        <div className="card card-padded-sm al-dlq" role="region" aria-label="SIEM forwarder configuration">
          <div className="al-dlq__header">
            <strong>SIEM forwarder configuration</strong>
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => setSiemOpen(false)}
              aria-label="Close SIEM config panel"
            >
              ✕
            </button>
          </div>
          {siemLoading && <div className="al-dlq__empty">Loading…</div>}
          {!siemLoading && (
            <div className="al-siem">
              <p className="al-siem__hint">
                Push every audit-log row to an external SIEM (Splunk HEC, Datadog Logs Intake,
                Elastic ingest, etc.) via signed HTTPS POST. Events that fail dispatch after 3
                retries land in the <strong>DLQ</strong> for manual replay.
              </p>

              {siemConfig && (
                <div className="al-siem__status">
                  <strong>Current:</strong>{" "}
                  <code>{siemConfig.targetUrl}</code>
                  {" · "}
                  {siemConfig.enabled ? (
                    <span className="al-siem__badge al-siem__badge--on">enabled</span>
                  ) : (
                    <span className="al-siem__badge al-siem__badge--off">disabled</span>
                  )}
                  {" · secret "}<code>{siemConfig.hmacSecret}</code>
                </div>
              )}

              <label className="al-siem__field">
                <span className="al-siem__label">Target URL <span className="al-siem__required">*</span></span>
                <input
                  type="url"
                  className="input"
                  value={siemForm.targetUrl}
                  onChange={(e) => setSiemForm((f) => ({ ...f, targetUrl: e.target.value }))}
                  placeholder="https://your-siem.example.com/services/collector"
                  disabled={siemSaving}
                  required
                />
              </label>

              <label className="al-siem__field">
                <span className="al-siem__label">
                  HMAC secret <span className="al-siem__required">*</span>{" "}
                  <span className="al-siem__hint-inline">(min 32 chars; sent only on save — server stores AES-256-GCM encrypted)</span>
                </span>
                <input
                  type="password"
                  className="input"
                  value={siemForm.hmacSecret}
                  onChange={(e) => setSiemForm((f) => ({ ...f, hmacSecret: e.target.value }))}
                  placeholder={siemConfig ? "Leave blank to keep existing — enter a new value to rotate" : "At least 32 characters"}
                  autoComplete="new-password"
                  disabled={siemSaving}
                />
              </label>

              <label className="al-siem__field">
                <span className="al-siem__label">
                  Custom headers <span className="al-siem__hint-inline">(optional JSON object, e.g. <code>{`{"Authorization": "Splunk <token>"}`}</code>)</span>
                </span>
                <textarea
                  className="input al-siem__textarea"
                  value={siemForm.headersJson}
                  onChange={(e) => setSiemForm((f) => ({ ...f, headersJson: e.target.value }))}
                  placeholder='{"Authorization": "Splunk YOUR-TOKEN"}'
                  rows={3}
                  disabled={siemSaving}
                />
              </label>

              <label className="al-siem__field al-siem__field--checkbox">
                <input
                  type="checkbox"
                  checked={siemForm.enabled}
                  onChange={(e) => setSiemForm((f) => ({ ...f, enabled: e.target.checked }))}
                  disabled={siemSaving}
                />
                <span>Enabled — push events to the target on every audit-log row</span>
              </label>

              {siemError && (
                <div className="banner banner-error al-siem__error" role="alert">{siemError}</div>
              )}

              <div className="al-siem__actions">
                <button
                  className="btn btn-primary btn-sm"
                  // hmacSecret is optional on UPDATE (existing config) — the
                  // server reuses the stored encrypted blob when omitted.
                  // It IS required when creating a new config.
                  onClick={handleSiemSave}
                  disabled={siemSaving || !siemForm.targetUrl || (!siemConfig && !siemForm.hmacSecret)}
                >
                  {siemSaving ? "Saving…" : siemConfig ? "Save changes" : "Enable forwarder"}
                </button>
                {siemConfig && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={handleSiemDelete}
                    disabled={siemSaving}
                  >
                    Remove configuration
                  </button>
                )}
              </div>
            </div>
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