import React from "react";
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
 * Three panels stacked under `<h2>` headers, no inner tabs. Total
 * height fits in ~2 screens — the tab bar was overkill.
 */
const WEB_VITAL_METRICS = [
  { key: "webVitals.lcp",  budgetKey: "lcp",  title: "LCP (ms)"  },
  { key: "webVitals.cls",  budgetKey: "cls",  title: "CLS"       },
  { key: "webVitals.inp",  budgetKey: "inp",  title: "INP (ms)"  },
  { key: "webVitals.ttfb", budgetKey: "ttfb", title: "TTFB (ms)" },
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

  return (
    <div className="ps-section">
      <section className="ps-section__block">
        <h2 className="ps-section__title">Quality Gates</h2>
        <p className="ps-section__desc">
          Pass-rate, failure, and flaky-test thresholds. Runs that violate any
          gate are marked failed and post `gateResult: failed` to GitHub Checks.
        </p>
        <QualityGatesPanel
          projectId={project.id}
          canEdit={canEdit}
          onToast={onToast}
        />
      </section>

      <section className="ps-section__block">
        <h2 className="ps-section__title">Web Vitals Budgets</h2>
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

      <section className="ps-section__block">
        <h2 className="ps-section__title">Coverage</h2>
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
  );
}
