import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldCheck, TrendingUp, Wrench, Clock, BarChart3, Wrench as WrenchIcon } from "lucide-react";
import { api } from "../api.js";
import StatCard from "../components/shared/StatCard.jsx";
import EmptyState from "../components/shared/EmptyState.jsx";
import usePageTitle from "../hooks/usePageTitle.js";
import VisionHealPanel from "../components/healing/VisionHealPanel.jsx";

const EMPTY_SUMMARY = {
  strategies:   [],
  topSelectors: [],
  estimates:    { testsThatWouldHaveFailed: 0 },
  savingsTrend: [],
};

/** Maps strategyIndex to a human-readable name. */
const STRATEGY_LABELS = {
  "-1": "No strategy",
  "0":  "Direct match",
  "1":  "Text fallback",
  "4":  "Role fallback",
  "27": "AI selector",
};

/** badge class per action token in selector key. */
const ACTION_BADGE_CLASS = {
  fill:   "badge badge-blue",
  click:  "badge badge-purple",
  expect: "badge badge-green",
};

/** Split "action::label" healing key into its two parts. */
function parseSelector(raw = "") {
  const parts = raw.split("::");
  return { action: parts[0] || "", label: parts.slice(1).join("::") || raw };
}

// ─── Savings trend chart ──────────────────────────────────────────────────────
function SavingsTrendChart({ samples = [], navigate }) {
  const visible = samples.slice(-30);
  const avg = visible.length
    ? visible.reduce((s, x) => s + Number(x.value || 0), 0) / visible.length
    : 0;
  const max = Math.max(1, ...visible.map((s) => Number(s.value || 0)));

  const barHeightPct  = (v) => `${(Number(v || 0) / max) * 100}%`;
  const avgBottomPct  = `${(avg / max) * 100}%`;
  const firstTs = visible[0]?.ts;

  // ONB-002 (audit): bare "No savings data yet." replaced with the shared
  // empty-state shape — icon + title + description + CTA pointing at the
  // primary action that produces healing telemetry (running tests).
  if (visible.length === 0) {
    return (
      <EmptyState
        variant="bare"
        icon={<BarChart3 size={32} color="var(--text3)" />}
        title="No savings data yet"
        description="Self-healing telemetry appears here once tests run and the waterfall successfully repairs broken selectors."
        action={{ label: "Run tests", onClick: () => navigate?.("/runs"), variant: "ghost" }}
      />
    );
  }

  return (
    <div className="flex-col gap-sm">
      {/* Legend */}
      <div className="legend-row">
        <span className="legend-item">
          <span className="legend-dot" style={{ background: "var(--accent)" }} />
          <span className="legend-label">Per run</span>
        </span>
        <span className="legend-item">
          {/* dashed line swatch — purely decorative, no semantic value */}
          <span aria-hidden="true" style={{ width: 14, borderTop: "2px dashed var(--text3)", display: "inline-block" }} />
          <span className="legend-label">avg</span>
        </span>
      </div>

      {/* Chart area */}
      <div className="heal-chart-area">
        {/* Dashed average line — bottom% is data-driven so inline is correct */}
        <div className="heal-avg-line" aria-hidden="true" style={{ bottom: avgBottomPct }} />

        <div className="heal-chart-bars">
          {visible.map((s, i) => {
            const val      = Number(s.value || 0);
            const aboveAvg = val >= avg;
            const label    = `${new Date(s.ts * 1000).toLocaleDateString()}: ${val} saves`;
            return (
              <div
                key={i}
                title={label}
                className={aboveAvg ? "heal-chart-bar heal-chart-bar--above" : "heal-chart-bar heal-chart-bar--below"}
                style={{ height: barHeightPct(val) }}   /* data-driven — must be inline */
              />
            );
          })}
        </div>
      </div>

      {/* X-axis date labels */}
      <div className="heal-chart-axis">
        <span className="text-xs text-muted">
          {firstTs
            ? new Date(firstTs * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })
            : ""}
        </span>
        <span className="text-xs text-muted">Today</span>
      </div>

      {/* Average callout */}
      <p className="hint">Dashed line = 30-day average ({avg.toFixed(1)} saves/run)</p>
    </div>
  );
}

// ─── Strategy horizontal bars ─────────────────────────────────────────────────
function StrategyBars({ strategies = [] }) {
  if (strategies.length === 0) {
    return <p className="text-sm text-muted">No strategy data yet.</p>;
  }

  const sorted = [...strategies].sort((a, b) => b.successRate - a.successRate);

  return (
    <div className="heal-strategy-list">
      {sorted.map((s) => {
        const pct   = Math.round(s.successRate * 100);
        const label = STRATEGY_LABELS[String(s.strategyIndex)] ?? `Strategy ${s.strategyIndex}`;

        /* Colour is semantic/data-driven — stays inline */
        const barColor  = pct === 0 ? "var(--red)"   : pct >= 90 ? "var(--accent)" : "var(--amber)";
        const textColor = pct === 0 ? "var(--red)"   : pct >= 90 ? "var(--green)"  : "var(--amber)";

        return (
          <div key={String(s.strategyIndex)} className="heal-strategy-row">
            <div className="heal-strategy-header">
              <span className="text-sm font-semi">{label}</span>
              <span className="text-sm font-semi" style={{ color: textColor }}>{pct}%</span>
            </div>
            <div className="progress-bar">
              {/* width and background are data-driven */}
              <div
                className="progress-bar-fill"
                style={{ width: `${pct}%`, background: barColor }}
              />
            </div>
            <p className="hint">{s.successes}/{s.total} healed</p>
          </div>
        );
      })}
    </div>
  );
}

// ─── Top healed selectors table ───────────────────────────────────────────────
function SelectorsTable({ selectors = [], navigate }) {
  // ONB-002 (audit): bare empty-state lifted to the shared shape. CTA links
  // to Runs — the surface that produces healing rows once selectors break.
  if (selectors.length === 0) {
    return (
      <EmptyState
        variant="bare"
        icon={<WrenchIcon size={32} color="var(--text3)" />}
        title="No healed selectors yet"
        description="The self-healing waterfall logs every selector it repairs here. Run an approved test against a changed page to see entries."
        action={{ label: "Run tests", onClick: () => navigate?.("/runs"), variant: "ghost" }}
      />
    );
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Action</th>
          <th>Selector</th>
          <th style={{ textAlign: "right" }}>Repairs</th>
          <th style={{ textAlign: "right" }}>Total</th>
        </tr>
      </thead>
      <tbody>
        {selectors.map((s) => {
          const { action, label } = parseSelector(s.selector);
          const badgeCls = ACTION_BADGE_CLASS[action] ?? "badge badge-gray";
          return (
            <tr key={s.selector}>
              <td><span className={badgeCls}>{action || "—"}</span></td>
              <td className="mono truncate">{label}</td>
              <td className="font-semi" style={{ textAlign: "right", color: "var(--accent)" }}>
                {s.healCount}
              </td>
              <td className="text-sub" style={{ textAlign: "right" }}>{s.totalCount}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function HealingDashboard() {
  usePageTitle("Healing");
  const navigate = useNavigate();

  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .getHealingSummary()
      .then((d) => { if (!cancelled) { setData(d);            setLoading(false); } })
      .catch(()  => { if (!cancelled) { setData(EMPTY_SUMMARY); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const stats = useMemo(() => {
    if (!data) return null;
    const testsSaved        = data.estimates?.testsThatWouldHaveFailed ?? 0;
    const healing           = (data.strategies || []).filter((s) => s.strategyIndex > 0);
    const totalAttempts     = healing.reduce((s, x) => s + x.total,     0);
    const totalSuccesses    = healing.reduce((s, x) => s + x.successes, 0);
    const healRate          = totalAttempts ? Math.round((totalSuccesses / totalAttempts) * 100) : 0;
    const selectorsRepaired = (data.topSelectors || []).length;
    const activeStrategies  = (data.strategies   || []).filter((s) => s.total > 0).length;
    return { testsSaved, healRate, selectorsRepaired, activeStrategies };
  }, [data]);

  if (loading) {
    return (
      <div className="fade-in page-container-xl" style={{ padding: "24px 28px" }}>
        <div className="page-header">
          <div>
            <h1 className="page-title">Self-healing telemetry</h1>
            <p className="page-subtitle">Workspace-wide selector repair activity — last 30 days</p>
          </div>
        </div>
        <div className="stat-grid mb-lg">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="card" style={{ height: 88 }}>
              <div className="skeleton" style={{ height: "100%", borderRadius: "var(--radius-lg)" }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const healRateColor =
    (stats?.healRate ?? 0) >= 90 ? "var(--green)"
    : (stats?.healRate ?? 0) > 0 ? "var(--amber)"
    : "var(--text3)";

  const healRateSub =
    (stats?.healRate ?? 0) >= 90 ? "↑ 2pp"
    : (stats?.healRate ?? 0) > 0 ? "Below threshold"
    : "No data";

  return (
    <div className="fade-in page-container-xl" style={{ padding: "24px 28px" }}>

      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Self-healing telemetry</h1>
          <p className="page-subtitle">Workspace-wide selector repair activity — last 30 days</p>
        </div>
      </div>

      {/* Stat cards */}
      <div className="stat-grid mb-lg">
        <StatCard
          label="Tests Saved"
          value={stats?.testsSaved ?? 0}
          sub={stats?.testsSaved > 0 ? `↑ ${stats.testsSaved} from last period` : "No failures averted yet"}
          color="var(--green)"
          icon={<ShieldCheck size={18} />}
        />
        <StatCard
          label="Heal Success Rate"
          value={stats ? `${stats.healRate}%` : "—"}
          sub={healRateSub}
          color={healRateColor}
          icon={<TrendingUp size={18} />}
        />
        <StatCard
          label="Selectors Repaired"
          value={stats?.selectorsRepaired ?? 0}
          sub={`across ${stats?.activeStrategies ?? 0} strategies`}
          color="var(--accent)"
          icon={<Wrench size={18} />}
        />
        <StatCard
          label="Avg Heal Time"
          value="—"
          sub="Timing not yet captured"
          color="var(--text3)"
          icon={<Clock size={18} />}
        />
      </div>

      <VisionHealPanel count={data?.visionHealCount || 0} costUsd={data?.visionHealCostUsd || 0} strategy={data?.visionHealStrategy || {}} />

      {/* Two-column: trend chart + strategy bars */}
      <div className="heal-two-col">
        <div className="card card-padded">
          <h2 className="section-title">Savings trend</h2>
          <p className="text-sm text-sub" style={{ marginBottom: 12, marginTop: -8 }}>
            Tests that would have failed without healing
          </p>
          <SavingsTrendChart samples={data?.savingsTrend || []} navigate={navigate} />
        </div>

        <div className="card card-padded">
          <h2 className="section-title">Strategy success rates</h2>
          <StrategyBars strategies={data?.strategies || []} />
        </div>
      </div>

      {/* Top healed selectors */}
      <div className="card mb-lg">
        <div className="heal-selectors-header flex-between">
          <h2 className="section-title" style={{ marginBottom: 0 }}>Top healed selectors</h2>
          {(data?.topSelectors?.length ?? 0) > 0 && (
            <span className="badge badge-gray">{data.topSelectors.length} selectors</span>
          )}
        </div>
        <SelectorsTable selectors={data?.topSelectors || []} navigate={navigate} />
      </div>

    </div>
  );
}