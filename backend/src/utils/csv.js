/**
 * @module utils/csv
 * @description Shared CSV parsing + iteration-cap helpers.
 *
 * §17 #1 / TD-012 extraction — `parseCsvRows` and `clampIterationCap` used
 * to live inline at the top of `backend/src/routes/tests.js` (1,941-line
 * god-object with 8 distinct concerns). They have no Express dependency
 * and only one in-tree caller today (the fixture-upload route), but the
 * `__testables` export surface + the existing `tests/fixture-iteration.test.js`
 * test file imply they were always intended to be reusable. Moving them
 * here makes the routes file shorter and lets future fixture-shaped
 * consumers (e.g. crawl-rules import, dataset upload) reuse the same
 * parser without re-importing from a routes file.
 *
 * ### Exports
 * - {@link parseCsvRows}      — RFC-4180-lite parser, header-row keyed rows.
 * - {@link clampIterationCap} — `[1, 100]` clamp with sensible default of 10.
 */

/**
 * CAP-001: parse RFC 4180-flavoured CSV into row objects keyed by the first
 * line's headers. Supports double-quoted fields with embedded commas, CRLF
 * newlines inside quoted fields, and `""` as an escaped double-quote.
 *
 * Intentionally not a full RFC 4180 implementation — we drop trailing blank
 * lines and unquoted whitespace around delimiters because fixture CSVs are
 * typically hand-edited or exported from spreadsheets where those quirks are
 * the norm. Pulling in a CSV dependency would be overkill for this scope
 * (see AGENT.md "Do not add large dependencies").
 *
 * @param {string} text
 * @returns {Array<Object>} Rows; empty array when text has fewer than 2
 *   non-empty logical lines (header + at least one data row).
 */
export function parseCsvRows(text) {
  const src = String(text || "");
  if (!src.trim()) return [];

  // Tokenise into fields/rows respecting quoted segments.
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\n" || ch === "\r") {
      // Swallow paired \r\n as a single record separator
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = []; field = "";
      continue;
    }
    field += ch;
  }
  // Flush the trailing record if the file didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop fully-empty rows (blank trailing lines, double newlines).
  const cleaned = rows.filter((r) => r.some((c) => String(c).trim() !== ""));
  if (cleaned.length < 2) return [];

  const headers = cleaned[0].map((h) => String(h).trim());
  return cleaned.slice(1).map((cols) => {
    const obj = {};
    headers.forEach((h, idx) => {
      const raw = cols[idx];
      obj[h] = raw === undefined ? "" : String(raw).trim();
    });
    return obj;
  });
}

/**
 * CAP-001: clamp the fixture iteration cap to the [1, 100] range. Default of
 * 10 mirrors the per-project default documented in NEXT.md so a project
 * without an explicit `iterationCap` row still gets bounded dispatch.
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function clampIterationCap(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.max(1, Math.min(100, Math.floor(n)));
}
