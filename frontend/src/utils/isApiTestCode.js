/**
 * @module utils/isApiTestCode
 * @deprecated Use `test.isApiTest` from the backend response instead.
 * The backend now persists `isApiTest` on the test object (set by
 * testRunner.js during classification and updated by the PATCH endpoint
 * when playwrightCode changes). No need to reimplement the heuristic
 * on the frontend.
 *
 * This file is kept temporarily for backward compatibility but is no
 * longer imported by any component.
 */

/**
 * @param {string|null} code - Playwright test source code.
 * @returns {boolean}
 */
export default function isApiTestCode(code) {
  if (!code) return false;
  const usesRequest = /(?:request|apiContext|apiRequestContext)\s*\.\s*(newContext|get|post|put|patch|delete|head|fetch)\s*\(/.test(code);
  const usesPage = /page\s*\.\s*(goto|click|locator|getByRole|getByText|getByLabel|getByPlaceholder|fill|type|check|uncheck|selectOption|waitForSelector|waitForLoadState)\s*\(/.test(code);
  return usesRequest && !usesPage;
}
