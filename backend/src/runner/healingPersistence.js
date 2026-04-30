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
  });
}
