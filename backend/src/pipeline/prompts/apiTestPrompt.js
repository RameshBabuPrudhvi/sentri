/**
 * @module pipeline/prompts/apiTestPrompt
 * @description Builds the AI prompt for generating Playwright API tests from
 * captured HAR endpoint summaries.
 *
 * Unlike UI tests (which use `page.click()`, `page.fill()`), API tests use
 * Playwright's `request` API context (`apiRequestContext`) to make HTTP calls
 * directly and assert on status codes, response shapes, and headers.
 *
 * ### Exports
 * - {@link formatJsonExample} — `(raw, maxChars?) → string`
 * - {@link buildApiTestPrompt} — `(endpoints, appUrl) → { system, user }`
 */

import { isLocalProvider } from "../../aiProvider.js";
import { resolveTestCountInstruction } from "../promptHelpers.js";
import { PROMPT_VERSION } from "./outputSchema.js";

/**
 * Truncate a JSON request/response body example to fit within a token budget.
 *
 * For JSON arrays, incrementally includes elements until `maxChars` is reached.
 * For JSON objects, incrementally includes keys. Always preserves at least one
 * element/key so the shape is visible. Non-JSON payloads are sliced with a
 * `[truncated]` marker.
 *
 * @param {string|*} raw           — raw body string (or falsy/non-string passthrough)
 * @param {number}   [maxChars=1800] — approximate character budget
 * @returns {string} Truncated JSON or sliced string
 */
export function formatJsonExample(raw, maxChars = 1800) {
  if (!raw || typeof raw !== "string") return raw || "";
  if (raw.length <= maxChars) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Incrementally include elements until we exceed maxChars
      const compact = [];
      for (const item of parsed) {
        compact.push(item);
        if (JSON.stringify(compact, null, 2).length > maxChars) {
          compact.pop();
          break;
        }
      }
      // Always include at least one element so the shape is visible
      if (compact.length === 0 && parsed.length > 0) compact.push(parsed[0]);
      return JSON.stringify(compact, null, 2);
    }
    if (parsed && typeof parsed === "object") {
      const compact = {};
      for (const [k, v] of Object.entries(parsed)) {
        compact[k] = v;
        const next = JSON.stringify(compact, null, 2);
        if (next.length > maxChars) {
          delete compact[k];
          break;
        }
      }
      // Always include at least one key so the shape is visible
      if (Object.keys(compact).length === 0 && Object.keys(parsed).length > 0) {
        const [firstKey, firstVal] = Object.entries(parsed)[0];
        compact[firstKey] = firstVal;
      }
      return JSON.stringify(compact, null, 2);
    }
  } catch {
    // non-JSON payload; fall through
  }
  return `${raw.slice(0, maxChars)}\n... [truncated]`;
}

/**
 * Build the system + user prompt for API test generation.
 *
 * @param {ApiEndpoint[]} endpoints — from summariseApiEndpoints()
 * @param {string}        appUrl    — project base URL
 * @param {object}        [opts]
 * @param {string}        [opts.testCount] — dial value
 * @returns {{ system: string, user: string }}
 */
export function buildApiTestPrompt(endpoints, appUrl, { testCount = "ai_decides" } = {}) {
  const local = isLocalProvider();
  const testCountInstr = resolveTestCountInstruction(testCount, local);

  // Group endpoints by category for the prompt
  const gets    = endpoints.filter(e => e.method === "GET");
  const mutates = endpoints.filter(e => ["POST", "PUT", "PATCH", "DELETE"].includes(e.method));

  const system = `You are a senior API test automation engineer generating Playwright API tests.

PERSONA RULES:
- Generate tests that call HTTP endpoints directly using Playwright's request API context.
- Tests verify status codes, response JSON shapes, content-type headers, and error handling.
- Tests must be independent — no shared state between tests.
- Use REAL endpoint URLs and request bodies from the captured traffic below.
- For NEGATIVE tests: send malformed payloads, missing required fields, or wrong HTTP methods and assert the error response.

CODE REQUIREMENTS:
- Use \`request.newContext()\` for API calls, NOT \`page.goto()\`.
- Pattern: \`const api = await request.newContext({ baseURL: '${appUrl}' });\`
- For GET: \`const res = await api.get('/path');\`
- For POST: \`const res = await api.post('/path', { data: { ... } });\`
- Always assert: \`expect(res.status()).toBe(200);\`
- For JSON responses: \`const body = await res.json(); expect(body).toHaveProperty('key');\`
- When checking field types, use the ACTUAL type the API returns. If the API returns a JSON object for a field, check for \`"object"\`, not \`"string"\`. Only assert \`"string"\` when the API genuinely returns a string value.
- Always call \`await api.dispose();\` at the end of each test to clean up the API context.
- playwrightCode must be fully self-contained and executable.
- Import pattern: \`import { test, expect } from '@playwright/test';\`

FORBIDDEN — NEVER generate any of these in API tests:
- \`page.goto()\`, \`page.click()\`, or any \`page.*\` method — there is NO browser page in API tests.
- \`expect(page)\` or \`expect(page).toHaveURL()\` — the \`page\` object does not exist.
- \`page.waitForLoadState()\` or \`page.waitForSelector()\` — these are browser-only.
- Any reference to \`page\`, \`context\`, or \`browser\` variables — API tests only use \`request\`.

PROMPT VERSION: ${PROMPT_VERSION}`;

  // Build endpoint descriptions for the user message
  const endpointBlocks = endpoints.slice(0, local ? 10 : 20).map(ep => {
    const lines = [
      `  ${ep.method} ${ep.pathPattern}`,
      `    Observed ${ep.callCount}x | Status codes: ${ep.statuses.join(", ")} | Avg: ${ep.avgDurationMs}ms`,
      `    Example URL: ${ep.exampleUrls[0] || "N/A"}`,
    ];
    if (ep.requestBodyExample) {
      lines.push(`    Request body: ${formatJsonExample(ep.requestBodyExample)}`);
    }
    if (ep.responseBodyExample) {
      lines.push(`    Response body: ${formatJsonExample(ep.responseBodyExample)}`);
    }
    if (ep.pageUrls.length > 0) {
      lines.push(`    Triggered from: ${ep.pageUrls.join(", ")}`);
    }
    return lines.join("\n");
  }).join("\n\n");

  const user = `APPLICATION: ${appUrl}

DISCOVERED API ENDPOINTS (captured during live crawl):
${endpointBlocks || "  No API endpoints discovered."}

SUMMARY:
- ${gets.length} GET endpoints (data fetching)
- ${mutates.length} mutation endpoints (POST/PUT/PATCH/DELETE)
- ${endpoints.length} total unique endpoint patterns

REQUIRED TEST COVERAGE:
${testCountInstr} covering:
- POSITIVE: Each GET endpoint returns expected status (200) and valid JSON shape
- POSITIVE: POST/PUT endpoints accept valid payloads and return success
- NEGATIVE: Endpoints return appropriate error codes (400/401/404) for invalid requests
- ERROR PAYLOADS: Some APIs return HTTP 200 with error bodies instead of proper status codes — for POSITIVE tests assert the response body does NOT contain "error" or "message" failure indicators; for NEGATIVE tests assert the error payload structure (error field present, message is a non-empty string)
- CONTRACT: Response bodies match the observed JSON structure (required fields present)
- EDGE: Empty request bodies, missing content-type headers, wrong HTTP methods

STRICT RULES:
1. ${testCountInstr}
2. Use Playwright request API context — NOT page.goto() or browser navigation
3. Base URL: '${appUrl}' — use REAL paths from the discovered endpoints above
4. Every test must have at least 2 assertions (status code + response body/shape)
5. For POST/PUT tests, use the observed request body as a template
6. For POSITIVE tests, always verify the response body has NO error indicators: expect(body.error).toBeUndefined()
7. When example response bodies are provided, assert the EXACT structure — verify all top-level keys exist using toHaveProperty()
8. NEVER use \`page\`, \`expect(page)\`, \`page.goto()\`, or any browser API — this is an API-only test
9. When asserting typeof on response fields, match the ACTUAL type from the example response (object, string, number, boolean) — do NOT assume string for fields that are objects

Return ONLY valid JSON (no markdown, no code fences):
{
  "tests": [
    {
      "name": "API: descriptive name including endpoint and scenario",
      "description": "what this API test validates",
      "priority": "high|medium",
      "type": "integration",
      "scenario": "positive|negative|edge_case",
      "steps": [
        "Send GET request to /api/endpoint",
        "Verify response status is 200",
        "Verify response body contains expected fields"
      ],
      "playwrightCode": "import { test, expect } from '@playwright/test';\\n\\ntest('API: ...', async ({ request }) => {\\n  const api = await request.newContext({ baseURL: '${appUrl}' });\\n  const res = await api.get('/path');\\n  expect(res.status()).toBe(200);\\n  const body = await res.json();\\n  expect(body).toHaveProperty('key');\\n  await api.dispose();\\n});"
    }
  ]
}`;

  return { system, user };
}
