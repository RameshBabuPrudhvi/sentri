/**
 * @module utils/pagination
 * @description Shared pagination helper used by testRepo and runRepo.
 */

/**
 * @typedef {Object} PageMeta
 * @property {number}  total    - Total matching records (ignoring pagination).
 * @property {number}  page     - Current 1-based page number.
 * @property {number}  pageSize - Records per page.
 * @property {boolean} hasMore  - Whether a next page exists.
 */

/**
 * @typedef {Object} PagedResult
 * @property {Object[]} data - Deserialized records for the current page.
 * @property {PageMeta} meta - Pagination metadata.
 */

/**
 * Clamp and parse page / pageSize from route query params.
 * @param {string|number} [page=1]
 * @param {string|number} [pageSize=50]
 * @returns {{ page: number, pageSize: number, offset: number }}
 */
export function parsePagination(page, pageSize) {
  const rawP  = parseInt(page, 10);
  const rawPS = parseInt(pageSize, 10);
  const p  = Math.max(1, Number.isFinite(rawP) ? rawP : 1);
  const ps = Math.min(200, Math.max(1, Number.isFinite(rawPS) ? rawPS : 50));
  return { page: p, pageSize: ps, offset: (p - 1) * ps };
}
