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
  "tests/test-validator-allowlist.test.js",
  "tests/feedback-loop.test.js",
  "tests/pipeline-orchestrator.test.js",
  "tests/chat-window.test.js",
  "tests/password-reset-token.test.js",
  "tests/security-hardening.test.js",
  "tests/artifact-signing.test.js",
  "tests/soft-delete.test.js",
  "tests/recycle-bin.test.js",
  "tests/run-logs.test.js",
  "tests/webhook-token.test.js",
  "tests/scheduler.test.js",
  "tests/trigger-api.test.js",
  "tests/ssrf-protection.test.js",
  "tests/run-worker.test.js",
  "tests/code-executor-hybrid-request.test.js",
  "tests/abort-worker.test.js",
  "tests/notifications-api.test.js",
  "tests/email-verification.test.js",
  "tests/account-compliance.test.js",
  "tests/postgres-adapter.test.js",
  "tests/device-emulation.test.js",
  "tests/ai-fallback.test.js",
  "tests/api-versioning.test.js",
  "tests/robots-sitemap.test.js",
  "tests/openapi.test.js",
  "tests/locale-timezone.test.js",
  "tests/stale-detector.test.js",
  "tests/flaky-detector.test.js",
  "tests/recorder.test.js",
  "tests/visual-regression.test.js",
  "tests/recorder-baselines-routes.test.js",
  "tests/dns-classification.test.js",
  "tests/test-connection.test.js",
  "tests/cross-browser.test.js",
  "tests/playwright-export.test.js",
  "tests/test-retry.test.js",
  "tests/telemetry.test.js",
  "tests/network-conditions.test.js",
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
