/**
 * userRequestedPrompt.js — User-described test prompt template
 *
 * Used by generateFromDescription (POST /api/projects/:id/tests/generate) when
 * a user provides a specific name + description. Unlike buildIntentPrompt which
 * generates tests from crawled page data, this prompt generates tests focused
 * on the user's stated intent. The number of tests is controlled by the
 * `testCount` dial (1–20, default "one").
 *
 * Returns { system, user } for structured message support.
 */

import { isLocalProvider } from "../../aiProvider.js";
import { resolveTestCountInstruction } from "../promptHelpers.js";
import { buildSystemPrompt, buildOutputSchemaBlock } from "./outputSchema.js";

export function buildUserRequestedPrompt(name, description, appUrl, { testCount = "ai_decides" } = {}) {
  const local = isLocalProvider();
  const countInstruction = resolveTestCountInstruction(testCount, local);

  const user = `TEST NAME: ${name}
USER DESCRIPTION: ${description || "(no description provided)"}
APPLICATION URL: ${appUrl}

Your job is to generate test(s) that precisely match the user's request above.
Do NOT generate generic tests. Do NOT generate tests unrelated to the title and description.
The test(s) MUST directly verify what the user described — nothing more, nothing less.

STRICT RULES:
1. ${countInstruction} — focused entirely on what the user described
2. The test name should match or closely reflect the user's provided name
3. Steps must be specific to the described scenario, not generic page checks
4. CRITICAL: playwrightCode MUST start with: await page.goto('${appUrl}', { waitUntil: 'domcontentloaded', timeout: 30000 });
5. Base your assertions on the APPLICATION URL and USER DESCRIPTION provided above — use real content the user would expect to see
6. testData values are DOCUMENTATION ONLY — inline ALL values as string literals in playwrightCode.
   BAD: safeFill(page, 'Search', testData.searchTerm)  ← ReferenceError, testData doesn't exist at runtime
   GOOD: safeFill(page, 'Search', 'laptop')             ← literal string, always works
7. Count assertions: NEVER use greaterThan() — it is not Playwright API.
   BAD: expect(results).toHaveCount(greaterThan(0))
   GOOD: await expect(page.locator('.result')).not.toHaveCount(0)
   Locators MUST be written inline inside expect() — NEVER assigned to a const/let first.
8. If the user description contains MULTIPLE SCENARIOS (positive + negative/empty state),
   generate a SEPARATE test object for each scenario — never merge them into one test.

${buildOutputSchemaBlock()}`;

  return { system: buildSystemPrompt(), user };
}
