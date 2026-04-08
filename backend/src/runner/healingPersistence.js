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
 *   persistHealingEvents(db, testId, events)
 */

import { recordHealing, recordHealingFailure } from "../selfHealing.js";

/**
 * persistHealingEvents(db, testId, events)
 *
 * Writes healing events to the DB so future runs benefit from what we
 * learned.  Safe to call with an empty or undefined events array.
 *
 * @param {object}   db      — the in-memory database
 * @param {string}   testId  — the test these events belong to
 * @param {Array}    events  — healing events from runGeneratedCode
 */
export function persistHealingEvents(db, testId, events) {
  if (!events?.length || !db) return;

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
      recordHealingFailure(db, testId, action, label);
    } else {
      recordHealing(db, testId, action, label, evt.strategyIndex);
    }
  }
}
