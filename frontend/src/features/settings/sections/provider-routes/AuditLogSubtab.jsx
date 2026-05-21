import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle, FileText, RefreshCw,
} from "lucide-react";
import { api } from "../../../../api.js";
import { fmtAuditTimestamp } from "../../shared/formatters.js";
import { AUDIT_ACTIONS, AUDIT_PAGE_SIZE } from "./providerRoutes.constants.js";

/**
 * B3.9 — Audit log viewer subtab. Renders below the route list inside the
 * Provider Routes section so admins can see every mutation chronologically.
 *
 * Filters: action enum + free-form routeId. Pagination is cursor-based via
 * `before` (matches the backend repo's keyset). "Load more" stays visible
 * whenever the previous page returned `limit` rows. Metadata is JSON on the
 * wire — parsed defensively so a malformed entry never blanks the row.
 * Extracted from Settings.jsx (GAP-002).
 */
export default function AuditLogSubtab({ rows: routeRows }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filterAction, setFilterAction] = useState("");
  const [filterRouteId, setFilterRouteId] = useState("");
  const [hasMore, setHasMore] = useState(false);

  const routeNameById = useMemo(() => {
    const m = new Map();
    for (const r of (routeRows || [])) m.set(r.id, r.name);
    return m;
  }, [routeRows]);

  const load = useCallback(async ({ before, append } = {}) => {
    setLoading(true);
    setError("");
    try {
      const res = await api.listProviderRouteAudit({
        action: filterAction || undefined,
        routeId: filterRouteId || undefined,
        before: before || undefined,
        limit: AUDIT_PAGE_SIZE,
      });
      const next = res?.items || [];
      setItems((prev) => append ? [...prev, ...next] : next);
      setHasMore(next.length >= AUDIT_PAGE_SIZE);
    } catch (err) {
      setError(err.message || "Failed to load audit log.");
    } finally {
      setLoading(false);
    }
  }, [filterAction, filterRouteId]);

  useEffect(() => { load({}); }, [load]);

  function loadMore() {
    if (!items.length) return;
    load({ before: items[items.length - 1].createdAt, append: true });
  }

  function renderMetadata(row) {
    if (!row.metadata) return "—";
    try {
      const obj = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      const summary = [];
      if (obj.changed && Array.isArray(obj.changed)) summary.push(`changed: ${obj.changed.join(", ")}`);
      if (obj.lastFour) summary.push(`lastFour: ${obj.lastFour}`);
      if (obj.reachable != null) summary.push(`reachable: ${obj.reachable}`);
      if (obj.errorReason) summary.push(`error: ${obj.errorReason}`);
      if (obj.count != null) summary.push(`count: ${obj.count}`);
      if (obj.mode) summary.push(`mode: ${obj.mode}`);
      const text = summary.length ? summary.join(" · ") : JSON.stringify(obj).slice(0, 80);
      return <span title={JSON.stringify(obj, null, 2)}>{text}</span>;
    } catch {
      return <span className="text-mono">{String(row.metadata).slice(0, 80)}</span>;
    }
  }

  return (
    <div className="card-padded-sm st-pr-audit-panel">
      <div className="font-semi st-pr-audit-title">
        <FileText size={13} /> Audit log
      </div>
      <div className="text-xs text-muted st-pr-audit-sub">
        Every mutation to provider routes (create / update / delete / rotate-key) plus reads with side effects (probe / export / import). Retention defaults to 90 days; tune via <code>AI_ROUTES_AUDIT_RETENTION_DAYS</code>.
      </div>
      <div className="st-pr-audit-filters">
        <label className="st-pr-field">
          <span className="st-pr-field-label">Action</span>
          <select className="input" value={filterAction} onChange={(e) => setFilterAction(e.target.value)}>
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="st-pr-field">
          <span className="st-pr-field-label">Route</span>
          <select className="input" value={filterRouteId} onChange={(e) => setFilterRouteId(e.target.value)}>
            <option value="">All routes</option>
            {(routeRows || []).map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <div className="st-status-err"><AlertCircle size={12} /> {error}</div>
      )}
      {loading && items.length === 0 ? (
        <div className="text-sm text-muted st-pr-audit-empty">Loading audit log…</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-muted st-pr-audit-empty">
          No audit entries match the current filters.
        </div>
      ) : (
        <div className="st-pr-audit-table">
          {items.map((row) => (
            <div key={row.id} className="st-pr-audit-row">
              <span className="text-xs text-muted text-mono">{fmtAuditTimestamp(row.createdAt)}</span>
              <span className={`st-pr-badge st-pr-audit-action st-pr-audit-action--${row.action}`}>{row.action}</span>
              <span className="text-xs text-mono">{routeNameById.get(row.routeId) || row.routeId || "—"}</span>
              <span className="text-xs text-muted st-pr-audit-meta">{renderMetadata(row)}</span>
            </div>
          ))}
        </div>
      )}
      {hasMore && (
        <div className="st-pr-audit-actions">
          <button className="btn btn-ghost btn-sm" onClick={loadMore} disabled={loading}>
            {loading ? <RefreshCw size={13} className="spin" /> : null}
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
