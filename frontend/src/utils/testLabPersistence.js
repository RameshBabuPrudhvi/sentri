/**
 * @module utils/testLabPersistence
 * @description sessionStorage mirror for the Test Lab live-run view.
 *
 * The pipeline + log views are driven by component-local state in
 * `frontend/src/pages/TestLab.jsx` (`activeRun`, `runData`, `logLines`).
 * Without persistence, navigating away from Test Lab unmounts the component
 * and wipes the state, so returning mid-run shows an empty idle panel
 * instead of the in-flight pipeline. We mirror the live run to
 * sessionStorage so soft navigation within the app is seamless; on mount
 * we rehydrate and the SSE hook auto-reconnects (its `snapshot` event
 * refills pipeline counters, and new log lines resume streaming from the
 * reconnect point). sessionStorage is scoped per-tab, which matches the
 * UX we want.
 *
 * Extracted from TestLab.jsx as part of the page decomposition (audit §3.1).
 * Pure functions — no React imports, no hooks — so they can be unit-tested
 * without a renderer and reused if other surfaces ever need the same shape.
 */

export const STORAGE_KEY = "sentri.testLab.activeRun";
/** Bound the in-memory + sessionStorage log buffer. LiveLog renders -40. */
export const LOG_CAP = 200;

export function loadPersistedRun() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.activeRun?.runId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function persistRun(activeRun, runData, logLines) {
  try {
    if (!activeRun?.runId) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      activeRun,
      runData,
      logLines: logLines.slice(-LOG_CAP),
    }));
  } catch { /* quota / private mode — non-fatal */ }
}

export function clearPersistedRun() {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* non-fatal */ }
}
