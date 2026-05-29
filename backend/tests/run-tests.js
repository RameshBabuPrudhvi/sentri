/**
 * @module tests/run-tests
 * @description Unified backend test runner for all test files.
 */

import { spawnSync } from "node:child_process";

const files = [
  "tests/code-parsing.test.js",
  "tests/self-healing.test.js",
  // MNT-001 — host-side vision-healing waterfall (stages 7 pixelmatch + 8 LLM).
  // Stub-driven via dependency injection; no real CV / no real network in CI.
  "tests/self-healing-vision.test.js",
  // MNT-001b — real pixelmatch CV adapter, baseline crop persistence repo,
  // and per-project budget circuit breaker. Real SQLite + real pixelmatch
  // (no stubs); each fixture is synthesised in-memory.
  "tests/vision-heal-pixelmatch.test.js",
  "tests/element-baseline-repo.test.js",
  "tests/vision-budget-repo.test.js",
  // MNT-001b — coordinate re-action after a successful vision heal.
  // Unit-tested against a fake Playwright page; no real browser.
  "tests/vision-heal-reaction.test.js",
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
  // Bundle-A fix #8 — `buildImprovementPrompt` byte-size cap on the
  // elements-JSON block so verbose snapshots can't balloon the prompt.
  "tests/feedback-loop-prompt-cap.test.js",
  // Bundle-A fix #9 — `regenerateFailingTest` surfaces non-abort errors
  // via a warn log + `app_feedback_loop_regeneration_failures_total`.
  "tests/feedback-loop-regen-errors.test.js",
  // Bundle-A fix #10 — `detectFlakyTests` scoped to last N runs (default 50)
  // instead of walking the full project history.
  "tests/feedback-loop-flaky-window.test.js",
  // Bundle-A fix #19 — shared bot-detection pattern module so the
  // post-run classifier and the state explorer's crawl-time gate never drift.
  "tests/bot-detection.test.js",
  "tests/pipeline-orchestrator.test.js",
  // Bundle-A fix #6 — orchestrator resets `run.secretScanBlocked` at
  // entry so re-entry on the same run doesn't carry a stale flag.
  "tests/pipeline-orchestrator-secret-reset.test.js",
  // Bundle-A fix #7 — quality re-score runs AFTER healing transforms so
  // the `selector.semantic` factor matches the post-transform code.
  "tests/pipeline-orchestrator-quality-rescoring.test.js",
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
  // Task 2 — per-agent SSE events (migration 057). Pins persistence,
  // createdAt ordering, runRepo.getById hydration, cascade-delete, and the
  // emitAgentEvent broadcast contract (persists + delivers to runListeners).
  "tests/agentEvents.test.js",
  "tests/agent-envelope.test.js",
  "tests/agent-message-repo.test.js",
  "tests/agent-message-emitter.test.js",
  "tests/agent-blackboard.test.js",
  "tests/agent-tools-registry.test.js",
  "tests/agent-peer-qa.test.js",
  "tests/agent-tool-call-envelope.test.js",
  "tests/agent-tools-orchestrator.test.js",
  "tests/agent-reviewer-loop.test.js",
  "tests/agent-orchestrator.test.js",
  // Bundle-A fix #1 — orchestrator threads `replyToId` across supervisor
  // handoffs so the UI timeline can reconstruct the multi-step thread.
  "tests/agent-orchestrator-reply-chain.test.js",
  // AUTO-023 B4.1 — supervisor prompt builder + decision normaliser
  // branch coverage (terminate vs. route, missing instruction, empty
  // nextRole fallback).
  "tests/supervisor-prompt.test.js",
  // AUTO-023 B4.1 — supervisor LLM bridge (generateText → parseJSON →
  // normalizeSupervisorDecision). Pins happy-path JSON, parse-error
  // termination, dispatch-error termination (never re-thrown), and
  // the one-shot weak-supervisor-model advisory.
  "tests/supervisor-agent.test.js",
  // AUTO-023 B4.3 / B4.6 — dedicated coverage for the orchestrator's
  // ineligible-role fallback path. The roadmap lists this as a
  // separate file so a regression in the fallback hook surfaces in
  // isolation from the happy-path / max-steps cases.
  "tests/agent-orchestrator-fallback.test.js",
  // AUTO-023 B4.6 — role dispatcher + linear-fallback closure
  // (`makeRoleDispatcher` / `makeLinearFallback`). Pins reviewer
  // verdict → envelope intent mapping, oracle handoff round-trip,
  // unavailable-role envelopes, and dispatch-error containment.
  "tests/autonomous-dispatch.test.js",
  // AUTO-023 B4.7 — end-to-end acceptance pin for autonomous mode:
  // composes orchestrator + supervisor LLM bridge + role dispatcher
  // under stubbed generateText so a workspace flagged `'autonomous'`
  // produces tests via real supervisor routing decisions. Covers
  // single-turn terminate, multi-turn reviewer revise loop, and
  // supervisor parse-error safe termination.
  "tests/autonomous-mode-e2e.test.js",
  // AUTO-023 B4.4 — integration coverage for the new admin-gated
  // `/settings/agent-mode` endpoints + workspaceRepo round-trip.
  // Pins status codes, response shape, cross-workspace isolation,
  // 400 on invalid mode + defence-in-depth coercion at the repo layer.
  "tests/agent-mode-routes.test.js",
  "tests/reviewer-prompt.test.js",
  // AUTO-023 B3.3 — per-workspace `agent_configs.maxReviewRounds` override
  // (migration 059). Pins the repo-layer `[1, 10]` clamp + the loop's
  // resolution order (caller > workspace override > default).
  "tests/agent-config-max-review-rounds.test.js",
  // AUTO-023 B2.6 — envelope-mode pipeline handoff smoke test. Pins the
  // ordered explorer→planner→author thread, workspace scoping on
  // `listByThread`, the envelope-vs-pipeline read-mode gate, and the
  // emitter no-op contract on missing runId/threadId.
  "tests/agent-pipeline-envelope.test.js",
  // AUTO-023 Bundle 2 — unit coverage for `agentHandoff.js` thread-id
  // formatters + `agentMode.js` env-driven mode switch. Closes the
  // REVIEW.md mandatory-test gap on the two new helper modules.
  "tests/agent-handoff-mode.test.js",
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
  // ENT-004 (audit, migration 055) — `activities.runId` column + filter
  // regression coverage. Pins the auto-derive from `meta.runId`, workspace
  // ACL on the runId scope, and the explicit-arg-wins precedence rule.
  "tests/activity-runid-filter.test.js",
  // ENT-004 (audit, migration 054) — `tests.reviewComment` column + repo
  // round-trip. Locks down the Lifeguard-flagged VALID_COLS regression so
  // future refactors of testRepo.update can't silently drop the field.
  "tests/test-review-comment.test.js",
  // GAP-005 (audit, migration 056) — `aiRequestLogRepo.listByRun` regression
  // coverage. Pins workspace ACL, chronological ordering, null-runId
  // exclusion, and limit clamping for the new exported repo method.
  "tests/ai-request-log-list-by-run.test.js",
  // SEC-007 Part C — SIEM forwarder (HMAC + retry + DLQ + config CRUD).
  "tests/audit-siem-forwarder.test.js",
  "tests/postgres-adapter.test.js",
  "tests/device-emulation.test.js",
  "tests/ai-fallback.test.js",
  "tests/openrouter-provider.test.js",
  "tests/openai-compat-provider.test.js",
  "tests/aiProvider-adapter-contract.test.js",
  "tests/ai-provider-cost-tracking.test.js",
  "tests/compat-config-cache.test.js",
  "tests/agent-config-routes.test.js",
  // AI-005 — Multi-agent dispatch unit tests (resolveProvider, breakerKey,
  // per-role circuit breakers, fallbackRole cycle guard, sticky-fallback priority).
  "tests/agent-dispatch.test.js",
  // B1.8 — Per-workspace provider-routes (the route-driven dispatch path).
  // Each file pins one slice of the B1.x contract so a regression in one
  // module surfaces in isolation rather than as a cascade across files.
  "tests/provider-routes.test.js",       // B1.3 — repo CRUD + cycle guard + JSON round-trip + audit emission.
  "tests/secrets.test.js",               // B1.4 — AES-256-GCM encrypt/decrypt + master-key fail-fast + lastFour.
  "tests/protocol-adapter.test.js",      // B1.5 — protocol switch + streaming-parity fallback.
  "tests/resolve-route.test.js",         // B1.6 — resolveRoute priority chain + AI-005c collapse + shim.
  "tests/migration-routeid.test.js",
  "tests/request-log.test.js",
  "tests/migration-rollback.test.js",
  "tests/capability-probe.test.js",
  // PR #28 / Migration 060 — per-route probe-timeout override. Pins repo
  // column round-trip, `probeAndPersist` precedence chain (explicit arg →
  // route.probeTimeoutMs → env default), and the [1s, 10min] defence-in-
  // depth clamp applied before reaching `runCapabilityProbe`.
  "tests/probe-timeout.test.js",
  // PR #29 — Probe debounce + in-flight coalescing in providerRouteRepo.
  // Pins the recent-result skip, force: true bypass, concurrent-coalesce,
  // and the rotate-key gate's required force-skips-inflight semantics.
  "tests/probe-debounce.test.js",
  // PR #29 — B4.6 read-only routeGroupRepo. Per REVIEW.md mandatory-test
  // rule: covers list / getById / listMembers, member-count aggregates,
  // LEFT-JOIN safety for empty groups, capabilities JSON hydration, and
  // the workspace-scoping invariant (cross-workspace lookups return
  // undefined / [] rather than leaking existence).
  "tests/route-group-repo.test.js",
  // PR #29 regression — protocolAdapter.buildOpts forwarded-field
  // contract. Pins maxRetries + attemptTimeoutMs round-trip (the
  // keystone bug this PR shipped + then fixed: probes silently fell
  // back to 113s wall-clock because buildOpts dropped the fast-fail
  // knobs), the derivation of useJson from responseFormat, and the
  // no-leak invariant (caller fields outside the documented surface
  // must NOT appear on the output bag).
  "tests/protocol-adapter-opts.test.js",
  // PR #28 — `getAiProviderState()` registry inspector backing the new
  // `GET /api/v1/system/ai-state` route + Systems page "AI provider state"
  // panel. Pins the snapshot shape (healthy + open-breaker + sticky cases),
  // per-role key splitting, expired-sticky sweep contract, and JSON-safe
  // round-trip so `res.json()` never trips on a stray Map / Set reference.
  "tests/ai-state.test.js",
  // B3.7 — Token-bucket reserve + spend-cap enforcement.
  "tests/quota-guard.test.js",
  // B3.8 — Exact-match response cache + thundering-herd coalescing + janitor.
  "tests/response-cache.test.js",
  // B4.1 / B4.4 — "no code edits to add a vendor" contract test. Registers
  // a `family: "custom"` route at runtime, points it at a mock OpenAI
  // server, and asserts dispatch reaches the mock with the operator-set
  // apiKey + baseUrl + model. Pins the central guarantee from the
  // roadmap's "Definition of done" — passes once `_callProviderUnsafe`
  // dispatches real routes through `protocolAdapter.generate(route, …)`
  // (B4.1) instead of the legacy `adapterFor(provider)` switch.
  "tests/no-code-edits-contract.test.js",
  "tests/chaos-provider.test.js",        // B1.8 — error-injection: 500s, malformed JSON, mid-stream abort, breaker.
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
  // GAP-001 — Global data search (workspace-scoped LIKE-based) backing ⌘K.
  "tests/search.test.js",
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
  "tests/coverage-aggregator.test.js",
  "tests/run-coverage-integration.test.js",
  "tests/run-shard-coverage.test.js",        // AUTO-009f — sharded-run parity regression
  "tests/coverage-shard-merge.test.js",      // AUTO-009k — two-stage per-shard pre-aggregation + set-union merge
  "tests/coverage-memory-ceiling.test.js",   // AUTO-009g — memory-ceiling enforcement
  "tests/coverage-pr-diff.test.js",          // AUTO-009d — PR-scoped coverage diff (the Codecov play)
  "tests/source-map-resolver.test.js",
  "tests/server-coverage-proxy.test.js", // AUTO-009h — server-side coverage capture for API tests
  "tests/observability.test.js",
  "tests/health-routes.test.js",
  // INF-009 — Worker /healthz endpoint 200/503 contract. Reconstructs the
  // http.createServer handler from `backend/src/worker.js` so we can pin
  // the kubelet probe shape without booting BullMQ/Redis/Postgres.
  "tests/worker-health.test.js",
  // AUTO-022 — AI eval harness scorer + regression-detection + metric_samples persistence.
  "tests/eval-pipeline.test.js",
  "tests/eval-regression.test.js",
  "tests/eval-persistence.test.js",
  // AUTO-022 — CLI E2E subprocess tests for run-eval.mjs exit codes + report artifact.
  "tests/eval-cli-e2e.test.js",
    // B3.11 — Integration tests for the new operator surface.
  "tests/provider-routes-api.test.js",
  "tests/routes-import-export.test.js",
  "tests/compat-migration.test.js",
  "tests/concurrent-dispatch.test.js",
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
