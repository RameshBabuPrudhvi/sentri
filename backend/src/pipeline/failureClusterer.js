/**
 * @module pipeline/failureClusterer
 * @description Deterministic run-failure clustering (no DB, no LLM calls).
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

function editDistance(a, b) {
  const aa = a || "";
  const bb = b || "";
  if (!aa || !bb) return Math.max(aa.length, bb.length);
  const dp = Array.from({ length: aa.length + 1 }, () => new Array(bb.length + 1).fill(0));
  for (let i = 0; i <= aa.length; i++) dp[i][0] = i;
  for (let j = 0; j <= bb.length; j++) dp[0][j] = j;
  for (let i = 1; i <= aa.length; i++) {
    for (let j = 1; j <= bb.length; j++) {
      const c = aa[i - 1] === bb[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + c);
    }
  }
  return dp[aa.length][bb.length];
}

/**
 * @param {Object} input
 * @param {Array} [input.results] - Test result rows; only entries with `status === "failed"` cluster.
 * @returns {Array} Clusters sorted by descending size.
 */
export function clusterFailures({ results }) {
  const rows = Array.isArray(results) ? results.filter((r) => r?.status === "failed") : [];
  if (rows.length === 0) return [];

  const clusters = [];
  for (const row of rows) {
    const errorPattern = normalizeError(row.error || row.message || "unknown_error");
    const sharedUrl = getSourceUrl(row);
    const sharedSelector = getSelector(row);

    const existing = clusters.find((c) => {
      if (c.errorPattern !== errorPattern) return false;
      const sameUrl = c.sharedUrl === sharedUrl;
      if (sameUrl) return true;
      if (!c.sharedSelector || !sharedSelector) return false;
      return editDistance(c.sharedSelector, sharedSelector) <= 4;
    });

    if (existing) {
      existing.affectedTestIds.push(row.testId);
      existing.size += 1;
      continue;
    }

    clusters.push({
      fingerprint: `${errorPattern}|${sharedUrl || ""}|${sharedSelector || ""}`,
      affectedTestIds: [row.testId],
      sharedUrl: sharedUrl || null,
      sharedSelector: sharedSelector || null,
      errorPattern,
      size: 1,
    });
  }

  return clusters.sort((a, b) => b.size - a.size);
}
