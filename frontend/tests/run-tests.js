/**
 * @module tests/run-tests
 * @description Unified frontend test runner with backend-aligned output.
 */

import { spawnSync } from "node:child_process";

const files = [
  "tests/utils.test.js",
  "tests/more-utils.test.js",
  "tests/csrf.test.js",
  "tests/api.integration.test.js",
  "tests/test-fix.test.js",
  "tests/command-palette.test.js",
  "tests/query-client.test.js",
  "tests/extractCodeBlock.test.js",
  "tests/automation-status.test.js",
  "tests/approval-provenance.test.js",
  // AUTO-022 — score-format helpers powering the EvalPanel ScoreBadge.
  "tests/eval-score-format.test.js",
  // Audit fix — notification-coerce helpers that prevent `[object Object]`
  // from rendering in the bell when a callsite passes a non-string title.
  "tests/notification-coerce.test.js",
  // Task 3 — AgentConversation turn synthesizer + step → agent-sequence
  // resolver. Pure-logic test of `agentConversationSynth.js` (the JSX-free
  // sibling of `AgentConversation.jsx`); visual layers (streaming cursor,
  // ARIA wiring, auto-scroll) are covered by the Task 3 manual acceptance
  // criteria since the codebase doesn't ship a JSX testing framework.
  "tests/AgentConversation.test.js",
];

let passed = 0;
let failed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, [file], {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  if (result.status === 0) {
    passed += 1;
  } else {
    failed += 1;
  }
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed out of ${files.length} test files`);

if (failed > 0) {
  console.log("\n⚠️  Frontend test run failed");
  process.exit(1);
}

console.log("\n🎉 All frontend tests passed!");
