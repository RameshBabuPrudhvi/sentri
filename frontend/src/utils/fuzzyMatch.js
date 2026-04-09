/**
 * @module utils/fuzzyMatch
 * @description Pure fuzzy string matching for the command palette.
 *
 * Returns { match, score, ranges } where:
 *   - match:  boolean — all query chars found in order
 *   - score:  number  — lower is better (gap penalties, prefix/substring bonuses)
 *   - ranges: Array<[start, end]> — matched character ranges for highlighting
 *
 * Zero dependencies, zero LLM cost — runs entirely on the client.
 */

/**
 * Fuzzy-match `query` against `text`.
 *
 * @param   {string} query - The search string (user input).
 * @param   {string} text  - The target string to match against.
 * @returns {{ match: boolean, score: number, ranges: Array<[number, number]> }}
 */
export default function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { match: true, score: 0, ranges: [] };

  let qi = 0;
  let score = 0;
  let lastMatchIdx = -2;
  const ranges = [];
  let rangeStart = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (ti !== lastMatchIdx + 1) {
        score += ti - lastMatchIdx;
        if (rangeStart !== -1) ranges.push([rangeStart, lastMatchIdx]);
        rangeStart = ti;
      } else if (rangeStart === -1) {
        rangeStart = ti;
      }
      lastMatchIdx = ti;
      qi++;
    }
  }

  if (qi < q.length) return { match: false, score: Infinity, ranges: [] };
  if (rangeStart !== -1) ranges.push([rangeStart, lastMatchIdx]);
  if (t.startsWith(q)) score -= q.length * 10;
  if (t.includes(q)) score -= q.length * 5;

  return { match: true, score, ranges };
}
