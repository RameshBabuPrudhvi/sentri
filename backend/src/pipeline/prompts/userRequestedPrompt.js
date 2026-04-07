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

${buildOutputSchemaBlock()}`;

  return { system: buildSystemPrompt(), user };
}
