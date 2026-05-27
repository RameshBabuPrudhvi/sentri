/**
 * @module utils/generatedOutcome
 * @description Pure helper that splits a generation run's `testsGenerated`
 *   total into `drafts` vs `autoApproved` counts using the workspace tests
 *   array (which carries the authoritative `reviewStatus` +
 *   `approvalSource` columns).
 *
 * Why this matters — the run payload reports `testsGenerated` as a single
 * count and the SSE `done` event only carries that total. Without the
 * split, the completion banner labels every test a "draft" even when the
 * project's auto-approval threshold cleared some of them, contradicting
 * what the user sees the moment they land in Review Queue.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` (audit §3.1, pass 3).
 * Pure function so callers (today: the page's `useMemo`; tomorrow:
 * `<RunDoneBanner>` if it ever computes its own) can re-derive without
 * caring about the React renderer.
 *
 * @param {{ testsGenerated?: number, tests?: string[] }} runData
 * @param {Array<{ id: string, reviewStatus?: string, approvalSource?: string }>} allTests
 * @returns {{ total: number, drafts: number, autoApproved: number }}
 */
export function splitGeneratedOutcome(runData, allTests) {
  const total = runData?.testsGenerated ?? 0;
  const ids = Array.isArray(runData?.tests) ? runData.tests : [];
  if (!ids.length || !allTests?.length) {
    // Fall back to the legacy "treat as drafts" shape until the tests
    // cache refreshes — matches pre-fix behaviour and avoids flashing
    // "0 drafts" while the refetch is in flight.
    return { total, drafts: total, autoApproved: 0 };
  }
  const idSet = new Set(ids);
  let drafts = 0;
  let autoApproved = 0;
  for (const t of allTests) {
    if (!idSet.has(t.id)) continue;
    if (t.reviewStatus === "approved" && t.approvalSource === "auto") autoApproved++;
    else if (!t.reviewStatus || t.reviewStatus === "draft") drafts++;
  }
  return { total, drafts, autoApproved };
}
