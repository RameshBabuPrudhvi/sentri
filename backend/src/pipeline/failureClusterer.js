/**
 * @module pipeline/failureClusterer
 * @description Deterministic run-failure clustering (no DB, no LLM calls).
 *
 * ### Matching heuristic
 * Two failed results merge into the same cluster when ALL of:
 *   1. Their normalised `errorPattern` strings are byte-equal, AND
 *   2. Either (a) both carry the same non-null URL origin prefix, OR
 *      (b) both carry a non-empty selector and the Levenshtein edit
 *      distance between the two selectors is ≤ 4, OR
 *      (c) neither side carries a URL or a selector (fallback: error-
 *      pattern equality alone — see "Null-URL + null-selector" below).
 *
 * ### Known limitations (intentional trade-offs)
 *
 * **`size` vs `affectedTestIds.length`** — `size` counts every failed
 * result row contributing to the cluster (so a data-driven test with N
 * failing iterations contributes N), while `affectedTestIds` is the
 * deduplicated set of distinct test IDs. The Run Detail UI surfaces
 * `affectedTestIds.length` for the "N affected test(s)" copy so per-test
 * counts don't double-count iterations / retries.
 *
 * **Null-URL + null-selector merges** — when neither side has a URL or
 * a selector (e.g. a thrown error before the first navigation), the
 * matcher falls back to error-pattern equality alone. Acceptable for
 * "AI provider returned 503" style failures; documented here rather
 * than gated because the alternative (singleton clusters per URL-less
 * failure) is the worse UX.
 */

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function getSourceUrl(result) {
  const raw = result?.sourceUrl || result?.url || result?.step?.url || "";
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const segs = u.pathname.split("/").filter(Boolean).slice(0, 1);
    return `${u.origin}/${segs.join("/")}`.replace(/\/$/, "");
  } catch {
    return String(raw).split("?")[0].split("#")[0];
  }
}

function getSelector(result) {
  return normalizeText(result?.selector || result?.step?.selector || result?.failingSelector || "");
}

function normalizeError(error) {
  return normalizeText(error)
    .replace(/https?:\/\/[^\s)]+/g, "<url>")
    .replace(/\b\d+\b/g, "<num>");
}

/**
 * Levenshtein edit distance with O(min(n, m)) memory via a two-row
 * rolling array. Selectors are typically short (< 100 chars) so the
 * quadratic time bound is fine; the rolling-array shape removes a
 * sharp edge if a stack trace ever leaks into the selector field.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  const aa = a || "";
  const bb = b || "";
  if (!aa || !bb) return Math.max(aa.length, bb.length);
  // Ensure `s1` is the shorter side so the rolling rows are min-sized.
  let s1 = aa;
  let s2 = bb;
  if (s1.length > s2.length) { const t = s1; s1 = s2; s2 = t; }
  let prev = new Array(s1.length + 1);
  let curr = new Array(s1.length + 1);
  for (let i = 0; i <= s1.length; i++) prev[i] = i;
  for (let j = 1; j <= s2.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= s1.length; i++) {
      const c = s1[i - 1] === s2[j - 1] ? 0 : 1;
      curr[i] = Math.min(prev[i] + 1, curr[i - 1] + 1, prev[i - 1] + c);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[s1.length];
}

/**
 * @param {Object} input
 * @param {Array} [input.results] - Test result rows; only entries with `status === "failed"` cluster.
 * @returns {Array} Clusters sorted by descending size, each shaped:
 *   `{ fingerprint, affectedTestIds[], sharedUrl, sharedSelector, errorPattern, size }`.
 *   - `size` — total failed-result rows in the cluster (includes data-driven iterations).
 *   - `affectedTestIds` — deduplicated set of distinct test IDs.
 */
export function clusterFailures({ results }) {
  const rows = Array.isArray(results) ? results.filter((r) => r?.status === "failed") : [];
  if (rows.length === 0) return [];

  // Internal scratchpad: each cluster also carries a `_seenTestIds` Set used
  // to dedup `affectedTestIds` in O(1). The Set is stripped before return so
  // the public shape stays JSON-serialisable.
  const clusters = [];
  for (const row of rows) {
    const errorPattern = normalizeError(row.error || row.message || "unknown_error");
    const sharedUrl = getSourceUrl(row);
    const sharedSelector = getSelector(row);
    const testId = row.testId ?? "unknown";

    const existing = clusters.find((c) => {
      if (c.errorPattern !== errorPattern) return false;
      // URLs only count as a positive merge signal when BOTH sides have one.
      // Without this guard `null === null` would merge every URL-less failure
      // on error-pattern alone, bypassing the selector check entirely.
      const sameUrl = c.sharedUrl != null && sharedUrl != null && c.sharedUrl === sharedUrl;
      if (sameUrl) return true;
      if (c.sharedSelector && sharedSelector) {
        return editDistance(c.sharedSelector, sharedSelector) <= 4;
      }
      // Fallback: both sides URL-less AND selector-less → merge on error
      // pattern alone (see module JSDoc § "Null-URL + null-selector merges").
      return c.sharedUrl == null && sharedUrl == null && !c.sharedSelector && !sharedSelector;
    });

    if (existing) {
      if (!existing._seenTestIds.has(testId)) {
        existing._seenTestIds.add(testId);
        existing.affectedTestIds.push(testId);
      }
      existing.size += 1;
      continue;
    }

    clusters.push({
      fingerprint: `${errorPattern}|${sharedUrl || ""}|${sharedSelector || ""}`,
      affectedTestIds: [testId],
      sharedUrl: sharedUrl || null,
      sharedSelector: sharedSelector || null,
      errorPattern,
      size: 1,
      _seenTestIds: new Set([testId]),
    });
  }

  // Strip the internal dedup Set before returning so the public shape stays
  // JSON-serialisable (the column is persisted via JSON.stringify in runRepo).
  return clusters
    .sort((a, b) => b.size - a.size)
    .map(({ _seenTestIds, ...c }) => c); // eslint-disable-line no-unused-vars
}
