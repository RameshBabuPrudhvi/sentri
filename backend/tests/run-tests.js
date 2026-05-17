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
  "tests/project-edit.test.js",
  "tests/auto-login.test.js",
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
  "tests/secret-scanner.test.js",
  "tests/pii-sanitizer.test.js",
  "tests/feedback-loop.test.js",
  "tests/pipeline-orchestrator.test.js",
  "tests/chat-window.test.js",
  "tests/test-edit-prompt.test.js",
  "tests/test-edit-chat.test.js",
  "tests/password-reset-token.test.js",
  "tests/security-hardening.test.js",
  "tests/artifact-signing.test.js",
  "tests/soft-delete.test.js",
  "tests/review-queue-filters.test.js",
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
  // SEC-004 — Multi-factor authentication (TOTP + WebAuthn + workspace enforcement).
  "tests/auth-mfa-totp.test.js",
  "tests/auth-mfa-enforcement.test.js",
  "tests/auth-webauthn.test.js",
  // SEC-007 — Compliance audit log (hash chain, retention, DLQ, routes).
  "tests/audit-log-routes.test.js",
  "tests/audit-auth-events.test.js",
  // SEC-007 Part C — SIEM forwarder (HMAC + retry + DLQ + config CRUD).
  "tests/audit-siem-forwarder.test.js",
  "tests/postgres-adapter.test.js",
  "tests/migration-runner.test.js",
  "tests/device-emulation.test.js",
  "tests/ai-fallback.test.js",
  "tests/openrouter-provider.test.js",
  "tests/openai-compat-provider.test.js",
  "tests/compat-config-cache.test.js",
  "tests/api-versioning.test.js",
  "tests/robots-sitemap.test.js",
  "tests/openapi.test.js",
  "tests/locale-timezone.test.js",
  "tests/stale-detector.test.js",
  "tests/flaky-detector.test.js",
  "tests/recorder.test.js",
  "tests/recorder-pause.test.js",
  "tests/recorder-redaction.test.js",
  "tests/projects-pages.test.js",
  "tests/visual-regression.test.js",
  "tests/recorder-baselines-routes.test.js",
  "tests/dns-classification.test.js",
  "tests/test-connection.test.js",
  "tests/cross-browser.test.js",
  "tests/playwright-export.test.js",
  "tests/test-retry.test.js",
  "tests/telemetry.test.js",
  "tests/network-conditions.test.js",
  "tests/accessibility-migration.test.js",
  "tests/accessibility-repo.test.js",
  "tests/object-storage.test.js",
  "tests/ephemeral-storage-warning.test.js",
  "tests/quality-gates.test.js",
  "tests/trace-viewer-static.test.js",
  "tests/run-compare.test.js",
  "tests/metric-samples.test.js",
  "tests/healing-summary.test.js",
  "tests/web-vitals-trend.test.js",
  "tests/auto-approval.test.js",
  "tests/auto-approval-routes.test.js",
  "tests/crawl-diff.test.js",
  "tests/crawl-baseline-repo.test.js",
  "tests/deployment-triggers.test.js",
  "tests/pr11-fixes.test.js",
  "tests/risk-scorer.test.js",
  "tests/impact-analysis.test.js",
  "tests/github-checks.test.js",
  "tests/github-install-callback.test.js",
  "tests/fixture-iteration.test.js",
  "tests/test-fixtures-routes.test.js",
  "tests/environments.test.js",
  "tests/shard-config.test.js",
  "tests/run-sharding.test.js",
  "tests/run-storage-concurrency.test.js",
  "tests/run-worker-shard-retry.test.js",
  "tests/run-abort-pubsub.test.js",
  "tests/run-shard-crash.test.js",
  "tests/run-shard-registry.test.js",
  "tests/run-shard-finalizer.test.js",
  "tests/failure-clusterer.test.js",
  "tests/worker-pool-dashboard.test.js",
  "tests/observability.test.js",
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
