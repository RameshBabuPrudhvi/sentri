/**
 * @module utils/pagination
 * @description Shared pagination helper used by testRepo and runRepo.
 *
 * All paginated list endpoints share the same default page size so API
 * consumers get a consistent experience.  Change {@link DEFAULT_PAGE_SIZE}
 * to adjust the global default; the `maxPageSize` guard prevents abuse.
 */

/** Default number of records per page when the caller omits `pageSize`. */
export const DEFAULT_PAGE_SIZE = 10;

/** Hard upper bound — requests above this are clamped silently. */
export const MAX_PAGE_SIZE = 200;

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
 * @param {string|number} [pageSize=DEFAULT_PAGE_SIZE]
 * @returns {{ page: number, pageSize: number, offset: number }}
 */
export function parsePagination(page, pageSize) {
  const rawP  = parseInt(page, 10);
  const rawPS = parseInt(pageSize, 10);
  const p  = Math.max(1, Number.isFinite(rawP) ? rawP : 1);
  const ps = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(rawPS) ? rawPS : DEFAULT_PAGE_SIZE));
  return { page: p, pageSize: ps, offset: (p - 1) * ps };
}
