/**
 * @module components/project/WebVitalsBudgetsPanel
 * @description Web Vitals budgets configuration panel for a project (AUTO-017.2).
 *
 * Mirrors `QualityGatesPanel` but for performance budgets backed by
 * `PATCH /api/v1/projects/:id/web-vitals-budgets`:
 *   - `lcp`  (ms)        — Largest Contentful Paint upper bound.
 *   - `cls`  (unitless)  — Cumulative Layout Shift upper bound (0–1 typical).
 *   - `inp`  (ms)        — Interaction to Next Paint upper bound.
 *   - `ttfb` (ms)        — Time To First Byte upper bound.
 *
 * Any subset of the four fields is valid — leave a field blank to skip it.
 * Inline reference values follow Google's official "Good" Web Vitals
 * thresholds so users have a sane default to type against.
 *
 * Loads via `api.getWebVitalsBudgets`; saves via `api.updateWebVitalsBudgets`;
 * clears via `api.deleteWebVitalsBudgets`. Mutations require `qa_lead`+ on the
 * backend, so the form is rendered read-only when `canEdit === false`.
 *
 * INP can stay `null` for tests that never trigger an interaction — the
 * evaluator skips `null` metrics, so an INP budget on an assertion-ending
 * test is silently ignored rather than falsely passing or failing.
 */

import React, { useMemo } from "react";
import { Gauge } from "lucide-react";
import { api } from "../../api.js";
import ConfigurablePanel from "./ConfigurablePanel.jsx";

const FIELDS = [
  { key: "lcp",  label: "LCP (ms)",
    help: "Largest Contentful Paint. Good ≤ 2500 · Needs-Improvement ≤ 4000.",
    min: 0, step: "1", placeholder: "2500" },
  { key: "cls",  label: "CLS",
    help: "Cumulative Layout Shift (unitless). Good ≤ 0.1 · Needs-Improvement ≤ 0.25.",
    min: 0, step: "0.01", placeholder: "0.1" },
  { key: "inp",  label: "INP (ms)",
    help: "Interaction to Next Paint. Good ≤ 200 · Needs-Improvement ≤ 500. Null on tests with no interaction.",
    min: 0, step: "1", placeholder: "200" },
  { key: "ttfb", label: "TTFB (ms)",
    help: "Time To First Byte. Good ≤ 800 · Needs-Improvement ≤ 1800.",
    min: 0, step: "1", placeholder: "800" },
];

/**
 * @param {Object}   props
 * @param {string}   props.projectId
 * @param {boolean}  props.canEdit  - Viewer renders the form read-only.
 * @param {Function} [props.onToast] - `(message, type) => void` for feedback.
 */
export default function WebVitalsBudgetsPanel({ projectId, canEdit, onToast }) {
  const panelApi = useMemo(() => ({
    load:  () => api.getWebVitalsBudgets(projectId),
    save:  (payload) => api.updateWebVitalsBudgets(projectId, payload),
    clear: () => api.deleteWebVitalsBudgets(projectId),
  }), [projectId]);

  return (
    <ConfigurablePanel
      title="Web Vitals Budgets"
      icon={<Gauge size={16} color="var(--accent)" />}
      description={
        <>
          Set per-page performance thresholds. The trigger response includes <code>webVitalsResult</code> so
          CI pipelines can fail the build on regressions. Leave a field blank to skip it. Reference values follow
          Google&rsquo;s &ldquo;Good&rdquo; Web Vitals thresholds.
        </>
      }
      fields={FIELDS}
      api={panelApi}
      resultKey="webVitalsBudgets"
      activeBadgeTitle="Budgets configured — runs include webVitalsResult"
      clearConfirm="Clear all Web Vitals budgets? Future runs will report webVitalsResult: null."
      toastMessages={{ saved: "Web Vitals budgets saved", cleared: "Web Vitals budgets cleared" }}
      readOnlyHint="Read-only — QA Lead or Admin role required to edit budgets."
      canEdit={canEdit}
      onToast={onToast}
      cardStyle={{ marginTop: 12 }}
      projectId={projectId}
    />
  );
}

