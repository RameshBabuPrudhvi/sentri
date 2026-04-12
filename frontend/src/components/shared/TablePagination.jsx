/**
 * @module components/TablePagination
 * @description Shared pagination bar for all data tables.
 *
 * Renders "N items · page X of Y" with Prev/Next buttons.
 * Only renders when totalPages > 1.
 *
 * @param {number} total      — total item count (unfiltered or filtered)
 * @param {number} page       — current 1-based page index
 * @param {number} totalPages — total number of pages
 * @param {Function} onPageChange — called with new page number
 * @param {string} [label="items"] — noun for the count (e.g. "tests", "runs")
 */
import React from "react";

export const PAGE_SIZE = 10;

export default function TablePagination({ total, page, totalPages, onPageChange, label = "items" }) {
  if (totalPages <= 1) return null;

  return (
    <div className="tests-pagination" style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "12px 16px", borderTop: "1px solid var(--border)",
    }}>
      <span style={{ fontSize: "0.78rem", color: "var(--text3)" }}>
        {total} {label} · page {page} of {totalPages}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          className="btn btn-ghost btn-xs"
          disabled={page === 1}
          onClick={() => onPageChange(page - 1)}
        >
          ← Prev
        </button>
        <button
          className="btn btn-ghost btn-xs"
          disabled={page === totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
