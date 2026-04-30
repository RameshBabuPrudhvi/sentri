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

export function buildTestEditUserContent(context, userRequest) {
  const testCode = typeof context.testCode === "string" ? context.testCode : "";
  const testName = typeof context.testName === "string" ? context.testName : "Unnamed test";
  const testSteps = Array.isArray(context.testSteps) ? context.testSteps : [];
  const compactSteps = testSteps.slice(0, 20).map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `Test name: ${testName}

User request:
${userRequest}

Current steps:
${compactSteps || "(none)"}

Current Playwright code:
\`\`\`javascript
${testCode}
\`\`\``;
}
