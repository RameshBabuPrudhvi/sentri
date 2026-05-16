/**
 * @module pages/AuditLog
 * @description Workspace audit log — immutable chronological feed of every
 * action taken across the workspace, grouped by calendar day.
 *
 * Covers all ACTIVITY_TYPES events: test approvals (auto + human), rejections,
 * restores, revokes, bulk actions, test create/edit/delete/generate.
 *
 * Features
 * ─────────
 * - Stats strip: events today, approvals 7 d (auto/human), fixes 7 d
 * - Free-text search (debounced 300 ms, mirrors ReviewQueue pattern)
 * - Event-type chip filter (all / approve / reject / bulk / create / other)
 * - Project dropdown filter
 * - Sort: newest / oldest
 * - Load-more pagination (offset-based, matches existing `getActivities` API)
 * - CSV export (uses shared `exportCsv` util — admin only)
 *
 * Data source: existing `GET /api/v1/activities` endpoint in system.js —
 * no backend changes required. The endpoint already supports `type`,
 * `projectId`, `after`, `before`, `limit`, `offset` query params and
 * workspace-scopes all results.
 *
 * Role access: viewer+ (mirrors ApprovalsTimeline).
 * CSV export: restricted to admin in the UI (server enforces nothing extra,
 * but the export just downloads what the viewer can already see anyway).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useNotifications } from "../context/NotificationContext.jsx";
import { ACTIVITY_TYPES } from "../constants/activityTypes.js";
import { fmtDateTime, fmtDate } from "../utils/formatters.js";
import { exportCsv } from "../utils/exportCsv.js";
import { userHasRole } from "../utils/roles.js";
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

        {/* Actor */}
        {entry.userName && (
          <span className="al-entry__actor">{entry.userName}</span>
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
  const isAdmin = userHasRole(user, "admin");
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
  const [total, setTotal]       = useState(0);
  const [offset, setOffset]     = useState(0);
  const [loading, setLoading]   = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]       = useState(null);
  const [stats, setStats]       = useState(null);

  // ── Stats ─────────────────────────────────────────────────────────────────
  // Compute from fetched rows rather than a dedicated endpoint — the backend
  // doesn't yet have a /activities/stats route and we can avoid a new endpoint
  // by computing counts client-side from the full (unfiltered) first fetch.
  // Fetched separately with limit=200 so the strip shows workspace-wide totals
  // regardless of the active project/type filter.
  useEffect(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    Promise.all([
      api.getActivities({ after: today.toISOString(), limit: 500 }),
      api.getActivities({ after: sevenDaysAgo.toISOString(), limit: 1000 }),
    ])
      .then(([todayRows, weekRows]) => {
        const todayArr  = Array.isArray(todayRows)  ? todayRows  : [];
        const weekArr   = Array.isArray(weekRows)   ? weekRows   : [];
        setStats({
          eventsToday:  todayArr.length,
          autoApprove7d: weekArr.filter(r => r.type === ACTIVITY_TYPES.TEST_AUTO_APPROVE).length,
          humanApprove7d: weekArr.filter(r => r.type === ACTIVITY_TYPES.TEST_APPROVE).length,
          revoked7d:    weekArr.filter(r => r.type === ACTIVITY_TYPES.TEST_REVOKE).length,
        });
      })
      .catch(() => {}); // stats strip is non-critical
  }, []);

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
      setOffset(0);
      setRows([]);
    }, 300);
  }

  // ── Build filter params for the API call ───────────────────────────────────
  const chip = TYPE_CHIPS.find((c) => c.key === typeKey) ?? TYPE_CHIPS[0];

  // The existing `getActivities` accepts a single `type` string.
  // For multi-type groups (approve, bulk) we make one call per type and merge.
  // For single-type groups we make one call.
  // For "all" we make one call with no type filter.
  const filterTypes = chip.types; // null | string[]

  // ── Fetch ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const before = sortOrder === "oldest"
      ? undefined
      : undefined; // newest-first is the API default

    // Build the shared filter object (without `type` — handled per-call below)
    const base = {
      projectId: projectId !== "all" ? projectId : undefined,
      limit:     PAGE_SIZE,
      offset:    0,
    };

    // For "oldest" sort we fetch in reverse by using `after` with a very old
    // date and relying on the API's DESC order, then reversing client-side.
    // The existing API has no `order` param, so we sort client-side for now.

    async function fetchRows() {
      let fetched = [];

      if (!filterTypes) {
        // All types
        const data = await api.getActivities({ ...base });
        fetched = Array.isArray(data) ? data : [];
      } else {
        // Fetch each type in the group and merge — the API supports one type
        // at a time. Use Promise.all so they run in parallel.
        const results = await Promise.all(
          filterTypes.map((t) => api.getActivities({ ...base, type: t }))
        );
        for (const r of results) {
          if (Array.isArray(r)) fetched.push(...r);
        }
        // Re-sort merged results by createdAt desc
        fetched.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      }

      // Client-side text filter (debouncedQ). The existing endpoint has no `q`
      // param, so we filter the returned rows locally.
      if (debouncedQ) {
        const lq = debouncedQ.toLowerCase();
        fetched = fetched.filter((r) => {
          return (
            (r.testName  || "").toLowerCase().includes(lq) ||
            (r.detail    || "").toLowerCase().includes(lq) ||
            (r.userName  || "").toLowerCase().includes(lq) ||
            (r.projectName || "").toLowerCase().includes(lq)
          );
        });
      }

      if (sortOrder === "oldest") fetched.reverse();

      return fetched;
    }

    fetchRows()
      .then((data) => {
        if (cancelled) return;
        setRows(data);
        setTotal(data.length);
        setOffset(data.length);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || "Failed to load audit log");
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [typeKey, projectId, sortOrder, debouncedQ]);

  // ── Load more ──────────────────────────────────────────────────────────────
  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const base = {
        projectId: projectId !== "all" ? projectId : undefined,
        limit:     PAGE_SIZE,
        offset,
      };

      let fetched = [];
      if (!filterTypes) {
        const data = await api.getActivities(base);
        fetched = Array.isArray(data) ? data : [];
      } else {
        const results = await Promise.all(
          filterTypes.map((t) => api.getActivities({ ...base, type: t }))
        );
        for (const r of results) {
          if (Array.isArray(r)) fetched.push(...r);
        }
        fetched.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      }

      if (debouncedQ) {
        const lq = debouncedQ.toLowerCase();
        fetched = fetched.filter((r) =>
          (r.testName || "").toLowerCase().includes(lq) ||
          (r.detail   || "").toLowerCase().includes(lq) ||
          (r.userName || "").toLowerCase().includes(lq) ||
          (r.projectName || "").toLowerCase().includes(lq)
        );
      }

      if (sortOrder === "oldest") fetched.reverse();

      setRows((prev) => [...prev, ...fetched]);
      setOffset((prev) => prev + fetched.length);
    } catch (err) {
      addNotification({ type: "error", message: err.message || "Failed to load more" });
    } finally {
      setLoadingMore(false);
    }
  }

  // ── CSV export ─────────────────────────────────────────────────────────────
  function handleExport() {
    const headers = ["Timestamp", "Type", "Test", "Project", "User", "Score", "Detail"];
    const csvRows = rows.map((r) => [
      r.createdAt,
      r.type,
      r.testName || r.detail || "",
      r.projectName || "",
      r.userName || "",
      r.meta?.score != null ? Number(r.meta.score).toFixed(2) : "",
      r.detail || "",
    ]);
    const date = new Date().toISOString().slice(0, 10);
    exportCsv(headers, csvRows, `sentri-audit-log-${date}.csv`);
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
            Every action across the workspace · Immutable
          </p>
        </div>
        <div className="al-header__actions">
          {isAdmin && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleExport}
              disabled={rows.length === 0}
            >
              Export CSV
            </button>
          )}
        </div>
      </div>

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

        {/* Project filter */}
        <select
          className="input al-toolbar__select"
          value={projectId}
          onChange={(e) => { setParam("projectId", e.target.value); setOffset(0); setRows([]); }}
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
          onChange={(e) => { setParam("sort", e.target.value); setOffset(0); setRows([]); }}
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
            onClick={() => { setTypeKey(chip.key); setOffset(0); setRows([]); }}
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

          {/* Load more */}
          {offset >= PAGE_SIZE && (
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