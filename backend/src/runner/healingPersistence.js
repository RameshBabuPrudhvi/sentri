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
import * as testRepo from "../database/repositories/testRepo.js";

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
    // Guard: a bug in findElement could push an event with a missing key
    // (e.g. if hintKey was null but the event was still emitted). Without
    // this check, evt.key.split("::") throws TypeError and halts persistence
    // of all subsequent events in the loop.
    if (!evt || typeof evt.key !== "string") continue;
    // Use bounded split so labels containing '::' don't corrupt args
    const [action, ...rest] = evt.key.split("::");
    const label = rest.join("::");
    if (evt.kind === "vision_pixelmatch" || evt.kind === "vision_llm") {
      visionHealCount += 1;
      if (evt.kind === "vision_pixelmatch") visionHealStrategy.pixelmatch += 1;
      if (evt.kind === "vision_llm") visionHealStrategy.llm += 1;
      if (Number.isFinite(evt.costUsd)) visionHealCostUsd += Number(evt.costUsd);
      continue;
    }
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
