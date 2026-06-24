/**
 * @module pages/Systems
 * @description System overview page — runtime infrastructure telemetry.
 *
 * Scope (post-cleanup): worker pool telemetry + AI dispatcher state.
 * The legacy AI-Provider summary card was removed because Settings →
 * AI Providers is the canonical surface for that data; the per-project
 * Application-Environments list was removed because Dashboard /
 * Projects / ProjectDetail already render those stats.
 *
 * AI provider state panel (added post-restructure): surfaces every open
 * circuit breaker + active sticky fallback the dispatcher's registry is
 * tracking, so operators can answer "tests stopped generating, what
 * happened?" without grepping log lines. Admin-only, fail-soft (panel
 * just doesn't render for non-admins or on fetch failure).
 */

import React, { useEffect, useState } from "react";
import { Server, Cpu, AlertTriangle, RefreshCw } from "lucide-react";
import { useDashboardQuery } from "../hooks/queries/useDashboardQuery.js";
import usePageTitle from "../hooks/usePageTitle.js";
import WorkerPoolPanel from "../components/shared/WorkerPoolPanel.jsx";
import { api } from "../api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { userHasRole } from "../utils/roles.js";

function SectionHeader({ icon, title, sub }) {
  return (
    <div className="sys-section-header">
      <div className="sys-section-header__icon">{icon}</div>
      <div>
        <div className="sys-section-header__title">{title}</div>
        {sub && <div className="sys-section-header__sub">{sub}</div>}
      </div>
    </div>
  );
}

/**
 * Format a millisecond duration as a compact human-readable string.
 * `45_000` → `"45s"`, `120_000` → `"2m"`, `350_000` → `"5m 50s"`.
 * Used by the AI state panel for "breaker reopens in 4m 12s" labels —
 * full precision (`new Intl.DurationFormat`) would be overkill here.
 */
function fmtRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

/**
 * AI dispatcher state panel — open breakers + active sticky fallbacks.
 *
 * Refetches every 30s while mounted so the panel stays current during
 * an active 429 incident without the operator hitting reload. Fail-soft
 * on the API call: viewer / qa_lead see a 403 and the panel collapses
 * to a muted "Admin-only" hint rather than rendering an error banner.
 *
 * Layout intent: green check when both lists are empty (healthy state),
 * red AlertTriangle when any breaker is open or sticky is active.
 */
function AiStatePanel() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState(null);

  const reload = async () => {
    setError(null);
    try {
      const data = await api.getAiState();
      setState(data);
      setForbidden(false);
    } catch (err) {
      // 403 → caller isn't admin; collapse the panel quietly. Any other
      // error renders as a muted retry hint.
      if (err?.status === 403) setForbidden(true);
      else setError(err?.message || "Could not load AI state.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // Auto-refresh every 30s. Matches the existing dashboard cadence
    // (TanStack Query defaults to `staleTime: 0` + window-focus refetch
    // there; we use a fixed interval here to keep the panel current
    // even when the tab is in the background during an incident).
    const id = setInterval(reload, 30_000);
    return () => clearInterval(id);
  }, []);

  if (forbidden) {
    return (
      <div className="card card-padded mb-md">
        <SectionHeader
          icon={<Cpu size={15} color="var(--accent)" />}
          title="AI provider state"
          sub="Admin-only — read-only diagnostic surface"
        />
        <div className="text-sm text-muted">
          You need workspace-admin role to view dispatcher state.
        </div>
      </div>
    );
  }

  const breakers = state?.breakers || [];
  const stickies = state?.stickyFallbacks || [];
  const openBreakers = breakers.filter((b) => b.openNow);
  const hasIssues = openBreakers.length > 0 || stickies.length > 0;

  return (
    <div className="card card-padded mb-md">
      <SectionHeader
        icon={hasIssues
          ? <AlertTriangle size={15} color="var(--red)" />
          : <Cpu size={15} color="var(--accent)" />}
        title="AI provider state"
        sub={hasIssues
          ? `${openBreakers.length} open breaker${openBreakers.length !== 1 ? "s" : ""} · ${stickies.length} sticky fallback${stickies.length !== 1 ? "s" : ""}`
          : "All circuits closed · no active fallbacks"}
      />
      {loading && !state ? (
        <div className="text-sm text-muted">Loading dispatcher state…</div>
      ) : error ? (
        <div className="text-sm text-muted">
          {error} <button className="btn btn-ghost btn-xs" onClick={reload}><RefreshCw size={11} /> Retry</button>
        </div>
      ) : !hasIssues ? (
        <div className="text-sm text-muted">
          The AI dispatcher has no open circuit breakers or sticky fallbacks. New
          provider failures trip a breaker after {state?.constants?.CIRCUIT_BREAKER_THRESHOLD ?? "?"} consecutive
          rate-limit errors and stay open for {fmtRemaining(state?.constants?.CIRCUIT_BREAKER_COOLDOWN_MS ?? 0)}.
        </div>
      ) : (
        <div className="text-sm">
          {openBreakers.length > 0 && (
            <>
              <div className="font-semi" style={{ marginBottom: 6 }}>Open breakers</div>
              <ul style={{ paddingLeft: 18, margin: "0 0 12px" }}>
                {openBreakers.map((b) => (
                  <li key={b.key} style={{ marginBottom: 4 }}>
                    <code>{b.provider}</code>
                    {b.agentRole && <> · role <code>{b.agentRole}</code></>}
                    {" — reopens in "}
                    <strong>{fmtRemaining(b.remainingMs)}</strong>
                    {" ("}{b.failures} failure{b.failures !== 1 ? "s" : ""}{")"}
                  </li>
                ))}
              </ul>
            </>
          )}
          {stickies.length > 0 && (
            <>
              <div className="font-semi" style={{ marginBottom: 6 }}>Sticky fallbacks</div>
              <ul style={{ paddingLeft: 18, margin: 0 }}>
                {stickies.map((s) => (
                  <li key={s.key} style={{ marginBottom: 4 }}>
                    <code>{s.provider}</code>
                    {s.agentRole && <> · role <code>{s.agentRole}</code></>}
                    {" — expires in "}
                    <strong>{fmtRemaining(s.remainingMs)}</strong>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Systems() {
  usePageTitle("System");
  const { user } = useAuth();
  const isAdmin = userHasRole(user, "admin");
  // DASH-003 (audit): worker-pool telemetry moved off the dashboard onto
  // this page. Reuses the dashboard query so a user navigating Dashboard
  // → System gets the cached payload immediately (TanStack Query caches
  // by query key — `useDashboardQuery` mounts in both surfaces share one
  // cache entry).
  const dashboardQuery = useDashboardQuery();
  const workerPool = dashboardQuery.data?.workerPool ?? null;

  if (dashboardQuery.isLoading) return (
    <div className="page-container sys-page">
      {/* Skeleton height drives layout shape — kept inline per AGENTS.md
          §127's data-driven carve-out. Everything else (border-radius,
          margin-bottom) lives on `.sys-skeleton`. */}
      <div className="skeleton sys-skeleton" style={{ height: 200 }} />
    </div>
  );

  return (
    <div className="fade-in page-container sys-page">

      {/* Header */}
      <div className="mb-lg">
        <h1 className="page-title">System</h1>
        <p className="page-subtitle">
          Worker pool telemetry and runtime infrastructure.
        </p>
      </div>

      {/* Worker pool telemetry (DASH-003, audit) — relocated from Dashboard.
          The /dashboard page now shows a single Platform Health card; the
          full 4-card breakdown lives here for operators who need the
          actual queue depth / active worker count / failed job tally. */}
      <div className="card card-padded mb-md">
        <SectionHeader
          icon={<Server size={15} color="var(--accent)" />}
          title="Worker Pool"
          sub={workerPool?.mode === "distributed"
            ? "Distributed BullMQ runners — Redis queue active"
            : workerPool
            ? "Single-process mode — no Redis configured"
            : "Telemetry unavailable"}
        />
        {workerPool ? (
          <WorkerPoolPanel workerPool={workerPool} variant="full" />
        ) : (
          <div className="text-sm text-muted">
            Worker pool telemetry will appear once the dashboard payload loads.
          </div>
        )}
      </div>

      {/* AI dispatcher state — admin-only, mounted via client-side gate.
          The route is gated server-side too (admin-only); the client gate
          here avoids firing the fetch for non-admins so a viewer doesn't
          see a 403 flash in their network tab. Defence-in-depth, not
          security boundary — the real ACL is the route. */}
      {isAdmin && <AiStatePanel />}

    </div>
  );
}
