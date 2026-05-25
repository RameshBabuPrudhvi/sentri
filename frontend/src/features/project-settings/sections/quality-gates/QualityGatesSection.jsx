import React, { useState } from "react";
import QualityGatesPanel from "../../../../components/project/QualityGatesPanel.jsx";
import WebVitalsBudgetsPanel from "../../../../components/project/WebVitalsBudgetsPanel.jsx";
import TrendChart from "../../../../components/shared/TrendChart.jsx";
import { useProjectMetricQuery } from "../../../../hooks/queries/useProjectMetricQuery.js";
import { useProjectSettings } from "../../components/ProjectSettingsContext.js";
import CoveragePanel from "./CoveragePanel.jsx";

/**
 * Quality Gates section — pass/fail signals on a run.
 *
 * Replaces the legacy "Quality Gates" outer tab + 3 of its 7 inner tabs
 * (gates / web-vitals / coverage) from `Automation.jsx → ProjectQualityCard`.
 * The other four tabs (auto-approval, iterations, PII firewall, vision
 * healing) are split into their own sections — see the registry in
 * `hooks/useProjectSettingsSections.js`.
 *
 * Three inner tabs (Quality Gates / Web Vitals Budgets / Coverage) using the
 * `.ps-tabs` / `.ps-tab--active` pattern from project-settings.css, matching
 * the `.st-pr-subtabs` tab style on the workspace AI Providers page.
 */
const WEB_VITAL_METRICS = [
  { key: "webVitals.lcp",  budgetKey: "lcp",  title: "LCP (ms)"  },
  { key: "webVitals.cls",  budgetKey: "cls",  title: "CLS"       },
  { key: "webVitals.inp",  budgetKey: "inp",  title: "INP (ms)"  },
  { key: "webVitals.ttfb", budgetKey: "ttfb", title: "TTFB (ms)" },
];

const TAB_LABELS = [
  { key: "gates",     label: "Quality Gates"     },
  { key: "webvitals", label: "Web Vitals Budgets" },
  { key: "coverage",  label: "Coverage"           },
];

function WebVitalTrend({ projectId, metricKey, title, threshold }) {
  const { data: samples } = useProjectMetricQuery(projectId, metricKey);
  return (
    <TrendChart
      title={title}
      samples={samples}
      threshold={Number.isFinite(Number(threshold)) ? Number(threshold) : null}
    />
  );
}

export default function QualityGatesSection() {
  const { project, canEdit, onToast } = useProjectSettings();
  const [activeTab, setActiveTab] = useState("gates");

  return (
    <div className="ps-section">
      {/* Section header */}
      <section className="ps-section__block">
        <h2 className="ps-section__title">Quality Gates</h2>
        <p className="ps-section__desc">
          Pass-rate, failure, and flaky-test thresholds. Runs that violate any
          gate are marked failed and post `gateResult: failed` to GitHub Checks.
        </p>
      </section>

      {/* Tab strip — WAI-ARIA tablist pattern (matches AiProvidersSection). */}
      <div className="ps-tabs" role="tablist" aria-label="Quality Gates sections">
        {TAB_LABELS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={activeTab === t.key}
            aria-controls={`ps-qg-tabpanel-${t.key}`}
            className={`btn btn-ghost btn-xs${activeTab === t.key ? " ps-tab--active" : ""}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Quality Gates tab ── */}
      {activeTab === "gates" && (
        <div id="ps-qg-tabpanel-gates" role="tabpanel" aria-label="Quality Gates">
          <QualityGatesPanel
            projectId={project.id}
            canEdit={canEdit}
            onToast={onToast}
          />
        </div>
      )}

      {/* ── Web Vitals Budgets tab ── */}
      {activeTab === "webvitals" && (
        <div id="ps-qg-tabpanel-webvitals" role="tabpanel" aria-label="Web Vitals Budgets">
          <section className="ps-section__block">
            <p className="ps-section__desc">
              Per-metric performance budgets enforced as gates. Trend charts below
              plot the last 30 days against the threshold line so violations are
              visible in context.
            </p>
            <WebVitalsBudgetsPanel
              projectId={project.id}
              canEdit={canEdit}
              onToast={onToast}
            />
            <div className="aap-webvitals-grid">
              {WEB_VITAL_METRICS.map((m) => (
                <WebVitalTrend
                  key={m.key}
                  projectId={project.id}
                  metricKey={m.key}
                  title={m.title}
                  threshold={project.webVitalsBudgets?.[m.budgetKey]}
                />
              ))}
            </div>
          </section>
        </div>
      )}

      {/* ── Coverage tab ── */}
      {activeTab === "coverage" && (
        <div id="ps-qg-tabpanel-coverage" role="tabpanel" aria-label="Coverage">
          <section className="ps-section__block">
            <p className="ps-section__desc">
              Browser JavaScript coverage capture + regression alert threshold.
              Use the Quality Gates "Max coverage regression" rule above to fail
              the run on a drop; this section only configures alerting.
            </p>
            <CoveragePanel
              project={project}
              canEdit={canEdit}
              onToast={onToast}
            />
          </section>
        </div>
      )}
    </div>
  );
}
