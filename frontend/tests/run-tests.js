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
