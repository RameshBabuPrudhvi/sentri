import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle, Check, FileText, Play, RefreshCw,
} from "lucide-react";
import { api } from "../../../../api.js";
import { fmtAuditTimestamp, fmtCost } from "../../shared/formatters.js";
import { AI_REQ_OUTCOMES, AI_REQ_PAGE_SIZE } from "./providerRoutes.constants.js";
import { isPromptReplayable } from "./providerRoutes.utils.js";

/**
 * B2.5 — AI request-log viewer. Mirrors `AuditLogSubtab`'s cursor-pagination
 * shape. Each row carries per-call telemetry (tokens, costUsd, latencyMs,
 * outcome) plus the redacted/raw prompt body. Admins can replay any
 * `full`-mode row against the same route.
 *
 * Replay is disabled when the row's `promptRedacted` is null (mode `"none"` at
 * capture) or contains a `[REDACTED_*]` sentinel (mode `"redacted"`) — the
 * backend rejects the replay with HTTP 400 anyway. Extracted from Settings.jsx
 * (GAP-002).
 */
export default function AiRequestLogSubtab({ rows: routeRows }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filterRouteId, setFilterRouteId] = useState("");
  const [filterOutcome, setFilterOutcome] = useState("");
  const [hasMore, setHasMore] = useState(false);
  // Per-row in-flight state for replay actions. Keyed by request id so a
  // running replay doesn't grey out other rows.
  const [replayState, setReplayState] = useState({});

  const routeNameById = useMemo(() => {
    const m = new Map();
    for (const r of (routeRows || [])) m.set(r.id, r.name);
    return m;
  }, [routeRows]);

  const load = useCallback(async ({ before, append } = {}) => {
    setLoading(true);
    setError("");
    try {
      const res = await api.listAiRequests({
        routeId: filterRouteId || undefined,
        outcome: filterOutcome || undefined,
        before: before || undefined,
        limit: AI_REQ_PAGE_SIZE,
      });
      const next = res?.items || [];
      setItems((prev) => append ? [...prev, ...next] : next);
      setHasMore(next.length >= AI_REQ_PAGE_SIZE);
    } catch (err) {
      setError(err.message || "Failed to load AI request log.");
    } finally {
      setLoading(false);
    }
  }, [filterRouteId, filterOutcome]);

  useEffect(() => { load({}); }, [load]);

  function loadMore() {
    if (!items.length) return;
    load({ before: items[items.length - 1].createdAt, append: true });
  }

  async function replay(row) {
    setReplayState((s) => ({ ...s, [row.id]: { kind: "running" } }));
    try {
      const res = await api.replayAiRequest(row.id, {});
      setReplayState((s) => ({ ...s, [row.id]: { kind: "ok", text: res?.text || "" } }));
    } catch (err) {
      setReplayState((s) => ({ ...s, [row.id]: { kind: "err", msg: err.message || "replay_failed" } }));
    }
  }

  return (
    <div className="card-padded-sm st-pr-audit-panel">
      <div className="font-semi st-pr-audit-title">
        <FileText size={13} /> AI request log
      </div>
      <div className="text-xs text-muted st-pr-audit-sub">
        Per-call telemetry for every AI dispatch. Storage mode is per workspace
        (<code>aiRequestLogMode</code>): <code>none</code> stores metadata only,
        <code>redacted</code> strips PII before persist, <code>full</code>
        stores raw prompts (admin opt-in required for replay). Retention defaults
        to 30 days; tune via {" "}<code>AI_REQUEST_LOG_RETENTION_DAYS</code>.
      </div>
      <div className="st-pr-audit-filters">
        <label className="st-pr-field">
          <span className="st-pr-field-label">Route</span>
          <select className="input" value={filterRouteId} onChange={(e) => setFilterRouteId(e.target.value)}>
            <option value="">All routes</option>
            {(routeRows || []).map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </label>
        <label className="st-pr-field">
          <span className="st-pr-field-label">Outcome</span>
          <select className="input" value={filterOutcome} onChange={(e) => setFilterOutcome(e.target.value)}>
            <option value="">All outcomes</option>
            {AI_REQ_OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      </div>
      {error && (
        <div className="st-status-err"><AlertCircle size={12} /> {error}</div>
      )}
      {loading && items.length === 0 ? (
        <div className="text-sm text-muted st-pr-audit-empty">Loading AI request log…</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-muted st-pr-audit-empty">
          No AI requests match the current filters.
        </div>
      ) : (
        <div className="st-pr-audit-table">
          {items.map((row) => {
            const replayable = isPromptReplayable(row.promptRedacted);
            const rep = replayState[row.id];
            return (
              <div key={row.id} className="st-pr-audit-row">
                <span className="text-xs text-muted text-mono">{fmtAuditTimestamp(row.createdAt)}</span>
                <span className={`st-pr-badge st-pr-audit-action st-pr-audit-action--${row.outcome === "success" ? "create" : row.outcome === "error" ? "delete" : "update"}`}>
                  {row.outcome}
                </span>
                <span className="text-xs text-mono">{routeNameById.get(row.routeId) || row.routeId || "—"}</span>
                <span className="text-xs text-muted st-pr-audit-meta">
                  {row.agentRole || "default"} · {row.inputTokens ?? "?"}+{row.outputTokens ?? "?"}t · {fmtCost(row.costUsd)} · {row.latencyMs ?? "?"}ms
                  {rep?.kind === "err" && <> · <span className="st-status-err"><AlertCircle size={11} /> {rep.msg}</span></>}
                  {rep?.kind === "ok" && <> · <span className="st-status-ok"><Check size={11} /> replayed</span></>}
                  <button
                    className="btn btn-ghost btn-xs"
                    onClick={() => replay(row)}
                    disabled={!replayable || rep?.kind === "running"}
                    title={replayable
                      ? "Re-issue this prompt against its original route. Requires storage mode 'full' at capture time."
                      : "Replay unavailable — prompt was captured under storage mode 'none' or 'redacted'."}
                  >
                    {rep?.kind === "running" ? <RefreshCw size={11} className="spin" /> : <Play size={11} />}
                    Replay
                  </button>
                </span>
              </div>
            );
          })}
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
