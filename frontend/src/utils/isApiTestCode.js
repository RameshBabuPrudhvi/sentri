/**
 * @module utils/isApiTestCode
 * @description Detect API-only tests on the frontend (mirrors backend isApiTest).
 *
 * Discovers variable names assigned from request.newContext() so that
 * `const api = await request.newContext(...)` followed by `api.get(...)` is
 * correctly detected as an API test (and the cURL button appears).
 *
 * Unlike the backend (which gates execution path), this is used only for UI
 * hints (cURL button, API badge). So we use a slightly looser heuristic:
 * expect(page) alone (without real page interactions like goto/click/fill)
 * is treated as an AI hallucination and ignored — the cURL button still shows.
 */

/**
 * @param {string|null} code - Playwright test source code.
 * @returns {boolean}
 */
export default function isApiTestCode(code) {
  if (!code) return false;

  // Direct request.* usage (matches backend isApiTest)
  let usesRequest = /(?:request|apiContext|apiRequestContext)\s*\.\s*(newContext|get|post|put|patch|delete|head|fetch)\s*\(/.test(code);

  // Also check variables assigned from newContext()
  if (!usesRequest) {
    const ctxAssignRe = /(?:const|let|var)\s+(\w+)\s*=\s*await\s+\w+\.newContext\s*\(/g;
    let m;
    while ((m = ctxAssignRe.exec(code)) !== null) {
      const varName = m[1];
      const varCallRe = new RegExp(`${varName}\\s*\\.\\s*(get|post|put|patch|delete|head|fetch)\\s*\\(`, "i");
      if (varCallRe.test(code)) {
        usesRequest = true;
        break;
      }
    }
  }

  // Real page interactions — page.goto(), page.click(), page.fill(), etc.
  // These definitively indicate a browser test.
  const usesPageInteraction = /page\s*\.\s*(goto|click|locator|getByRole|getByText|getByLabel|getByPlaceholder|fill|type|check|uncheck|selectOption|waitForSelector|waitForLoadState)\s*\(/.test(code);

  return usesRequest && !usesPageInteraction;
}
