/**
 * @module components/project/QualityGatesPanel
 * @description Quality-gate configuration panel for a project (AUTO-012b).
 *
 * Surfaces the three gate fields backed by `PATCH /api/v1/projects/:id/quality-gates`:
 *   - `minPassRate`  (0–100, %) — fail run when pass rate is below this.
 *   - `maxFlakyPct`  (0–100, %) — fail run when flaky % is above this.
 *   - `maxFailures`  (>= 0, integer) — fail run when failure count is above this.
 *   - `minCoveragePct`           (0–100, %) — AUTO-009d: fail when browser JS line coverage falls below this.
 *   - `minBranchPct`             (0–100, %) — AUTO-009d: fail when branch coverage falls below this (line-only runs no-op).
 *   - `minPrCoveragePct`         (0–100, %) — AUTO-009d: minimum coverage for PR-touched files (aliases overall coverage until AUTO-009e ships the PR-files filter).
 *   - `maxCoverageRegressionPct` (0–100, %) — AUTO-009d: max allowed drop relative to the previous coverage-enabled run.
 *
 * Any single field can be left blank to omit it from the gate config — the
 * server stores only the fields that are present, so partial configs are valid.
 *
 * Loads via `api.getQualityGates`; saves via `api.updateQualityGates`; clears
 * via `api.deleteQualityGates`. Mutations require `qa_lead`+ on the backend, so
 * the form is rendered read-only when `canEdit === false` (Viewer role).
 */

import React, { useMemo } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "../../api.js";
import ConfigurablePanel from "./ConfigurablePanel.jsx";

const FIELDS = [
  { key: "minPassRate", label: "Min pass rate (%)",
    help: "Run fails when pass rate falls below this. 0–100.",
    min: 0, max: 100, step: "0.1" },
  { key: "maxFlakyPct", label: "Max flaky %",
    help: "Run fails when flaky % exceeds this. 0–100.",
    min: 0, max: 100, step: "0.1" },
  { key: "maxFailures", label: "Max failures",
    help: "Run fails when total failures exceed this. Integer ≥ 0.",
    min: 0, step: "1" },
  // AUTO-009d — coverage gates. Only enforced when the project has
  // `coverageEnabled: true`; line-only coverage runs (no v8-to-istanbul
  // data) silently no-op the branch rule. Leave any field blank to omit
  // that particular threshold — the server-side validator (`routes/
  // projects.js#validateQualityGates`) only rejects a payload that
  // resolves to *zero* gate fields total.
  { key: "minCoveragePct", label: "Min coverage (%)",
    help: "Run fails when browser JS line coverage falls below this. Requires coverageEnabled. 0–100.",
    min: 0, max: 100, step: "0.1" },
  { key: "minBranchPct", label: "Min branch coverage (%)",
    help: "Run fails when branch coverage falls below this. Line-only coverage runs no-op this rule (no v8-to-istanbul data). 0–100.",
    min: 0, max: 100, step: "0.1" },
  { key: "minPrCoveragePct", label: "Min PR coverage (%)",
    help: "Minimum coverage for PR-touched files. Currently aliases overall coverage until AUTO-009e ships the PR-files filter. 0–100.",
    min: 0, max: 100, step: "0.1" },
  { key: "maxCoverageRegressionPct", label: "Max coverage regression (%)",
    help: "Run fails when coverage drops MORE than this versus the previous coverage-enabled run. Leave blank to disable — 0 means 'fail on ANY drop' (strictest). First coverage-enabled run never regresses (no prior to compare). 0–100.",
    min: 0, max: 100, step: "0.1" },
];

/**
 * @param {Object}   props
 * @param {string}   props.projectId
 * @param {boolean}  props.canEdit  - Viewer renders the form read-only.
 * @param {Function} [props.onToast] - `(message, type) => void` for feedback.
 */
export default function QualityGatesPanel({ projectId, canEdit, onToast }) {
  const panelApi = useMemo(() => ({
    load:  () => api.getQualityGates(projectId),
    save:  (payload) => api.updateQualityGates(projectId, payload),
    clear: () => api.deleteQualityGates(projectId),
  }), [projectId]);

  return (
    <ConfigurablePanel
      title="Quality Gates"
      icon={<ShieldCheck size={16} color="var(--accent)" />}
      description={
        <>
          Configure thresholds that future runs must meet. The trigger response includes <code>gateResult</code> so
          CI pipelines can fail the build on violation. Leave a field blank to skip it.
        </>
      }
      fields={FIELDS}
      api={panelApi}
      resultKey="qualityGates"
      activeBadgeTitle="Gates configured — runs include gateResult"
      clearConfirm="Clear all quality gates? Future runs will report gateResult: null."
      toastMessages={{ saved: "Quality gates saved", cleared: "Quality gates cleared" }}
      readOnlyHint="Read-only — QA Lead or Admin role required to edit gates."
      canEdit={canEdit}
      onToast={onToast}
      projectId={projectId}
    />
  );
}

