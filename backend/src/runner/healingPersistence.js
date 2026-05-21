/**
 * healingPersistence.js — Persist self-healing events from test execution
 *
 * During test execution, the self-healing runtime (injected via
 * getSelfHealingHelperCode) accumulates healing events — records of which
 * selector strategy succeeded or failed for each interaction.
 *
 * This module extracts the duplicated "walk events and call
 * recordHealing / recordHealingFailure" pattern that appeared in both the
 * success and failure branches of executeTest.
 *
 * Exports:
 *   persistHealingEvents(testId, events)
 */

import { recordHealing, recordHealingFailure } from "../selfHealing.js";
import { trackTelemetry } from "../utils/telemetry.js";
import { recordMetric } from "../utils/recordMetric.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { logActivity } from "../utils/activityLogger.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as projectRepo from "../database/repositories/projectRepo.js";

/**
 * persistHealingEvents(testId, events)
 *
 * Writes healing events to the DB so future runs benefit from what we
 * learned.  Safe to call with an empty or undefined events array.
 *
 * @param {string}   testId  — the test these events belong to
 * @param {Array}    events  — healing events from runGeneratedCode
 */
export function persistHealingEvents(testId, events) {
  if (!events?.length) return;

  // DIF-013: aggregate healing telemetry per test execution. One event with
  // counts is far more useful (and far less noisy) than one PostHog event
  // per heal attempt — we want to know "how often does healing fire" and
  // "which strategy index typically wins", not the per-element granularity
  // already captured in the healing_history table.
  let succeededCount = 0;
  let failedCount = 0;
  let visionHealCount = 0;
  let visionHealCostUsd = 0;
  const visionHealStrategy = { pixelmatch: 0, llm: 0 };
  // Histogram of which strategy index actually succeeded — index 0 means
  // "primary selector worked, no healing needed", >0 means a fallback won.
  const strategyHistogram = {};

  for (const evt of events) {
    if (!evt) continue;
    // MNT-001b — budget-exhausted sentinel never reaches persistence in
    // practice (executeTest.js filters it before pushing onto visionEvents),
    // but guard defensively so a future caller can't accidentally count a
    // skipped stage 8 as a "heal". The audit row + Prometheus counter are
    // the canonical record for budget-exhausted events.
    if (evt.kind === "vision_budget_exhausted") continue;
    if (evt.kind === "vision_pixelmatch" || evt.kind === "vision_llm") {
      visionHealCount += 1;
      if (evt.kind === "vision_pixelmatch") visionHealStrategy.pixelmatch += 1;
      if (evt.kind === "vision_llm") visionHealStrategy.llm += 1;
      if (Number.isFinite(evt.costUsd)) visionHealCostUsd += Number(evt.costUsd);

      // MNT-001b — SEC-007-compatible audit row, one per heal. Routed
      // through logActivity so workspace scoping + hash-chain continuation
      // happen automatically. The `kind` translates 1:1 to the activity
      // `type` (`healing.vision_pixelmatch` / `healing.vision_llm`) so SIEM
      // filters and the dashboard's audit-log drill-down can match on
      // `healing.vision_*`.
      //
      // No request context is available here (this runs from the test
      // runner, not an HTTP handler) — meta fields come from the event
      // itself + the test row's denormalised projectId / workspaceId.
      // workspaceId is the load-bearing field for multi-tenant scoping;
      // a row without it is invisible to `/api/v1/activities`, so we
      // skip the write rather than silently leak across workspaces.
      try {
        const baseTestId = String(testId).replace(/@v\d+$/, "");
        const test = testRepo.getById(baseTestId);
        if (test?.projectId && test?.workspaceId) {
          // Look up project name lazily — testRepo doesn't denormalise it.
          // Failure here is non-fatal; we'll log the row without it.
          let projectName = null;
          try {
            const project = projectRepo.getById(test.projectId);
            projectName = project?.name || null;
          } catch { /* projectRepo down — log without name */ }

          const confidencePct = Number.isFinite(evt.confidence)
            ? (evt.confidence * 100).toFixed(1)
            : "?";
          const detail = evt.kind === "vision_pixelmatch"
            ? `Vision healed via pixelmatch (confidence ${confidencePct}%)`
            : `Vision healed via LLM ${evt.model || "(unknown model)"} (confidence ${confidencePct}%, $${Number(evt.costUsd || 0).toFixed(4)})`;

          logActivity({
            type: `healing.${evt.kind}`,
            projectId: test.projectId,
            projectName,
            testId: baseTestId,
            testName: test.name || null,
            workspaceId: test.workspaceId,
            detail,
            meta: {
              key: evt.key,
              confidence: Number.isFinite(evt.confidence) ? evt.confidence : null,
              strategyIndex: evt.strategyIndex,
              box: evt.box || null,
              model: evt.model || null,
              costUsd: Number.isFinite(evt.costUsd) ? evt.costUsd : 0,
            },
          });
        }
      } catch (err) {
        // Audit write failure must not break heal recording — the heal
        // already happened; losing the audit row is a separate concern.
        console.warn(formatLogLine("warn", null,
          `[healing] Failed to write vision audit row for ${evt.key}: ${err.message}`));
      }
      continue;
    }
    // Guard: malformed non-vision entries without a key are ignored so one
    // bad event does not block persistence of the rest.
    if (typeof evt.key !== "string") continue;
    // Use bounded split so labels containing '::' don't corrupt args
    const [action, ...rest] = evt.key.split("::");
    const label = rest.join("::");
    if (evt.failed) {
      recordHealingFailure(testId, action, label);
      failedCount += 1;
    } else {
      recordHealing(testId, action, label, evt.strategyIndex);
      succeededCount += 1;
      const idx = Number.isInteger(evt.strategyIndex) ? evt.strategyIndex : -1;
      strategyHistogram[idx] = (strategyHistogram[idx] || 0) + 1;
    }
  }

  // Skip the telemetry call entirely when nothing healed AND nothing failed
  // (e.g. all events were malformed and skipped). trackTelemetry is already
  // a no-op when telemetry is disabled, but this avoids the function-call
  // overhead in the hot path.
  if (succeededCount === 0 && failedCount === 0) return;

  trackTelemetry("test.healing", {
    testId,
    succeeded: succeededCount,
    failed: failedCount,
    // PostHog accepts nested objects on `properties` — surfaces nicely as a
    // breakdown chart in the UI ("how often does strategy 2 win?").
    strategyHistogram,
    visionHealCount,
    visionHealCostUsd,
    visionHealStrategy,
  });

  // MET-001: record a savings sample so the healing dashboard's TrendChart
  // has real data. "Savings" = number of healing events that succeeded with a
  // non-primary strategy (index > 0) — i.e. tests that would have failed
  // without self-healing. Best-effort: testId may be a versioned scope
  // ("TC-1@v2") and the test row may have been deleted. We never rethrow —
  // telemetry must not flip a passing run — but we DO log a warning so
  // schema/migration issues (e.g. `metric_samples` table missing) are
  // diagnosable instead of silently swallowed.
  try {
    const nonPrimaryHeals = Object.entries(strategyHistogram)
      .filter(([idx]) => Number(idx) > 0)
      .reduce((sum, [, n]) => sum + n, 0);
    if (nonPrimaryHeals > 0) {
      const baseTestId = String(testId).replace(/@v\d+$/, "");
      const test = testRepo.getById(baseTestId);
      if (test?.projectId) {
        recordMetric(test.projectId, "healing.savings", nonPrimaryHeals, { testId: baseTestId });
      }
    }
  } catch (err) {
    console.warn(formatLogLine("warn", null, `[healing] failed to record savings metric for ${testId}: ${err.message}`));
  }
}
