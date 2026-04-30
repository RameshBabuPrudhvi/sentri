/**
 * @module routes/testEdit
 * @description Prompt builder for DIF-007 conversational test editing.
 *
 * When a chat request arrives with `context.mode === "test_edit"`, the
 * standard workspace-aware system prompt is swapped out for a dedicated
 * test-edit prompt that instructs the model to return a short summary plus
 * exactly one fenced JavaScript code block containing the full updated
 * Playwright test. Keeping this isolated from `chat.js` avoids bloating
 * that file and makes the test-edit contract easy to unit test.
 */

export const TEST_EDIT_SYSTEM_PROMPT = `You are Sentri AI operating in test-edit mode.
You will receive an existing Playwright test and a user edit request.

Return two sections in Markdown:
1) "### Summary" with a short explanation of the change
2) "### Updated Playwright Code" followed by exactly one \`\`\`javascript fenced code block containing the full updated test code.

Rules:
- Return complete runnable code, not partial snippets.
- Keep existing imports/setup unless the requested change requires edits.
- Do not include JSON wrappers.
- Do not omit the code block.`;

/**
 * Build the system + user prompt for a test-edit chat turn.
 *
 * @param {Object}  context      - Chat context object from the request body.
 * @param {string}  [context.testCode] - Current Playwright source.
 * @param {string}  [context.testName] - Human-readable test name.
 * @param {Array<string>} [context.testSteps] - Ordered step descriptions.
 * @param {{ content: string }} lastMessage - The latest user message.
 * @returns {{ systemPrompt: string, userContent: string }}
 */
export function buildTestEditPrompt(context, lastMessage) {
  const testCode = typeof context?.testCode === "string" ? context.testCode : "";
  const testName = typeof context?.testName === "string" ? context.testName : "Unnamed test";
  const testSteps = Array.isArray(context?.testSteps) ? context.testSteps : [];
  const compactSteps = testSteps.slice(0, 20).map((step, i) => `${i + 1}. ${step}`).join("\n");

  const userContent = `Test name: ${testName}

User request:
${lastMessage.content}

Current steps:
${compactSteps || "(none)"}

Current Playwright code:
\`\`\`javascript
${testCode}
\`\`\``;

  return { systemPrompt: TEST_EDIT_SYSTEM_PROMPT, userContent };
}
