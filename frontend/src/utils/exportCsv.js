/**
 * @module utils/exportCsv
 * @description Shared CSV export utilities.
 *
 * Used by Tests.jsx (bulk export) and TestDetail.jsx (single-test export
 * with run history). Centralises CSV escaping, Blob creation, and download
 * trigger so each page only needs to define its column schema + row mapper.
 *
 * ### Exports
 * - {@link csvEscape} — Escape a value for CSV.
 * - {@link buildCsv} — Build a CSV string from headers + rows.
 * - {@link downloadCsv} — Trigger a CSV file download.
 * - {@link exportCsv} — Build + download in one call.
 */

/**
 * Escape a value for CSV: wrap in double-quotes, escape inner quotes.
 * Handles null/undefined gracefully.
 *
 * @param {*} value
 * @returns {string}
 */
export function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

/**
 * Build a CSV string from headers + rows.
 *
 * @param {string[]} headers — column header labels
 * @param {Array<Array<*>>} rows — array of row arrays (raw values, will be escaped)
 * @returns {string} complete CSV content
 */
export function buildCsv(headers, rows) {
  const headerLine = headers.map(csvEscape).join(",");
  const dataLines = rows.map(row => row.map(csvEscape).join(","));
  return [headerLine, ...dataLines].join("\n");
}

/**
 * Trigger a CSV file download in the browser.
 *
 * @param {string} csv — CSV content string
 * @param {string} filename — download filename (should end in .csv)
 */
export function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  // Clean up the object URL after a tick to avoid memory leaks
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Convenience: build + download in one call.
 *
 * @param {string[]} headers
 * @param {Array<Array<*>>} rows
 * @param {string} filename
 */
export function exportCsv(headers, rows, filename) {
  downloadCsv(buildCsv(headers, rows), filename);
}
