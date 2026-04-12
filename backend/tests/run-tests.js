/**
 * @module tests/run-tests
 * @description Unified backend test runner for all test files.
 */

import { spawnSync } from "node:child_process";

const files = [
  "tests/code-parsing.test.js",
  "tests/self-healing.test.js",
  "tests/pipeline.test.js",
  "tests/api-flow.test.js",
  "tests/integration-routes.test.js",
  "tests/auth-cookies.test.js",
  "tests/utils.test.js",
  "tests/test-fix.test.js",
  "tests/healing-transforms.test.js",
  "tests/api-test-prompt.test.js",
  "tests/deduplicator.test.js",
  "tests/assertion-enhancer.test.js",
  "tests/test-validator.test.js",
  "tests/feedback-loop.test.js",
  "tests/pipeline-orchestrator.test.js",
  "tests/chat-window.test.js",
  "tests/password-reset-token.test.js",
  "tests/security-hardening.test.js",
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
  console.log("\n⚠️  Backend test run failed");
  process.exit(1);
}

console.log("\n🎉 All backend tests passed!");
