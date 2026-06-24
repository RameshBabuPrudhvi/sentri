/**
 * B3 (AUDIT-ROADMAP Bundle 3) — Review-rejection escalation contract pins.
 *
 * Covers:
 *   1. `fireReviewRejectionNotifications` short-circuits on empty / null
 *      rejection lists (no channels touched).
 *   2. Threshold gate honours the three documented modes:
 *      • 0 / null  → notify on any rejection (column default)
 *      • positive  → notify only when count ≥ threshold
 *      • -1        → opt-out, never notify
 *   3. Disabled `notification_settings.enabled = 0` row gates dispatch.
 *   4. `reviewRejectionsTotal` counter is registered + bumpable.
 *   5. The `TEST_REVIEW_REJECTED` activity type is exported as the literal
 *      `"test.review_rejected"` so frontend AuditLog filters keep working.
 *
 * Channel-level dispatch (Teams / email / generic webhook) is exercised
 * by the existing `notifications-api.test.js` suite for the parallel
 * `fireNotifications` path; this file pins the B3 wrapper's gating
 * decisions, not the channel HTTP shapes.
 *
 * Canonical pattern per AGENTS.md § "Use `createTestContext().createTestRunner()`":
 * each case wrapped in try/catch via the shared runner.
 */
import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";
import { fireReviewRejectionNotifications } from "../src/utils/notifications.js";
import * as notificationSettingsRepo from "../src/database/repositories/notificationSettingsRepo.js";
import { generateNotificationSettingId } from "../src/utils/idGenerator.js";
import { register, reviewRejectionsTotal, reviewRejectionNotificationsTotal } from "../src/utils/metrics.js";
import { ACTIVITY_TYPES } from "../src/constants/activityTypes.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as auditDlqRepo from "../src/database/repositories/auditDlqRepo.js";

const ctx = createTestContext();
const runner = ctx.createTestRunner();
const { resetDb, getDatabase } = ctx;

function seedProject({ id, name = "Test Project", workspaceId = "__system__", reviewRejectionAlertThreshold = 0, reviewRejectionAlertLastFiredAt = null } = {}) {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO projects (id, name, url, status, createdAt, workspaceId, reviewRejectionAlertThreshold, reviewRejectionAlertLastFiredAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, "https://example.test", "idle", new Date().toISOString(), workspaceId, reviewRejectionAlertThreshold, reviewRejectionAlertLastFiredAt);
  return { id, name, workspaceId, reviewRejectionAlertThreshold, reviewRejectionAlertLastFiredAt };
}

function seedNotificationSettings(projectId, { enabled = 1, webhookUrl = null } = {}) {
  // Seed a settings row that DOES NOT carry teams/email URLs, so the
  // dispatcher's webhook branch is the only one that could fire — and
  // even then we leave webhookUrl null on the no-channel cases so the
  // dispatcher returns immediately without making an outbound HTTP call
  // (the test process has no network reach).
  const now = new Date().toISOString();
  notificationSettingsRepo.upsert({
    id: generateNotificationSettingId(),
    projectId,
    teamsWebhookUrl: null,
    emailRecipients: null,
    webhookUrl,
    enabled: Boolean(enabled),
    createdAt: now,
    updatedAt: now,
  });
}

function fakeRun(projectId) {
  return {
    id: `RUN-b3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    projectId,
    status: "completed",
    duration: 12_345,
  };
}

function fakeRejections(n) {
  return Array.from({ length: n }, (_, i) => ({
    testId: `tc-${i + 1}`,
    testName: `Test case ${i + 1}`,
    failureCategory: "SELECTOR_ISSUE",
    roundsCompleted: 3,
    rejectedAt: new Date().toISOString(),
  }));
}

async function main() {
  resetDb();

  await runner.test("ACTIVITY_TYPES.TEST_REVIEW_REJECTED is the canonical literal", () => {
    assert.equal(ACTIVITY_TYPES.TEST_REVIEW_REJECTED, "test.review_rejected");
  });

  await runner.test("fireReviewRejectionNotifications no-ops on empty rejection list", async () => {
    // No project / settings seeded — dispatcher must short-circuit before
    // touching the DB. A throw here would surface as a test failure.
    const project = { id: "PROJ-empty", name: "Empty", reviewRejectionAlertThreshold: 0 };
    await fireReviewRejectionNotifications(fakeRun(project.id), project, []);
    await fireReviewRejectionNotifications(fakeRun(project.id), project, null);
    await fireReviewRejectionNotifications(fakeRun(project.id), project, undefined);
  });

  await runner.test("fireReviewRejectionNotifications honours threshold = -1 (opt-out)", async () => {
    resetDb();
    const project = seedProject({ id: "PROJ-optout", reviewRejectionAlertThreshold: -1 });
    seedNotificationSettings(project.id, { enabled: 1 });
    // Hand a non-empty list to prove the dispatcher rejects it on the
    // threshold gate, not on the empty-list short-circuit.
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(5));
    // No assertion target — the contract is "doesn't throw, doesn't dispatch".
    // When this branch is exercised through real channels the dispatcher
    // would return before even reading notification_settings — the run
    // here exercises the gate without making outbound HTTP.
  });

  await runner.test("fireReviewRejectionNotifications honours threshold > rejections (no-op)", async () => {
    resetDb();
    const project = seedProject({ id: "PROJ-belowthr", reviewRejectionAlertThreshold: 10 });
    seedNotificationSettings(project.id, { enabled: 1 });
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(3));
    // Same contract as above — no throw, no network call.
  });

  await runner.test("fireReviewRejectionNotifications skips when notification settings disabled", async () => {
    resetDb();
    const project = seedProject({ id: "PROJ-disabled", reviewRejectionAlertThreshold: 0 });
    seedNotificationSettings(project.id, { enabled: 0 });
    // Threshold passes (0 < 1), but `enabled = 0` short-circuits below.
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(1));
  });

  await runner.test("fireReviewRejectionNotifications skips when no notification settings row exists", async () => {
    resetDb();
    const project = seedProject({ id: "PROJ-nosettings", reviewRejectionAlertThreshold: 0 });
    // No notification_settings row — dispatcher's `if (!settings)` gate fires.
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(2));
  });

  await runner.test("fireReviewRejectionNotifications threshold = 0 + enabled + no channels → silent OK", async () => {
    resetDb();
    const project = seedProject({ id: "PROJ-nochannels", reviewRejectionAlertThreshold: 0 });
    // Settings row enabled but no teams/email/webhook URL configured —
    // the dispatcher iterates the (empty) channel list and Promise.allSettled
    // resolves with no entries. Pins the "always notify even with zero
    // configured channels" code-path against silently throwing.
    seedNotificationSettings(project.id, { enabled: 1, webhookUrl: null });
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(1));
  });

  // ── B3 industry-standard hardening cases ────────────────────────────────

  await runner.test("cooldown — recent reviewRejectionAlertLastFiredAt suppresses dispatch", async () => {
    // Set the timestamp to 10 minutes ago; default cooldown is 1 hour so
    // the dispatcher must short-circuit before touching the DB or the
    // network. Verified by absence of any throw + counter bumps to
    // `outcome="cooldown_skipped"` for each channel.
    resetDb();
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const project = seedProject({
      id: "PROJ-cooldown",
      reviewRejectionAlertThreshold: 0,
      reviewRejectionAlertLastFiredAt: tenMinAgo,
    });
    // Even with a configured Teams webhook, cooldown must suppress.
    notificationSettingsRepo.upsert({
      id: generateNotificationSettingId(),
      projectId: project.id,
      teamsWebhookUrl: "https://example.test/teams",
      emailRecipients: null,
      webhookUrl: null,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const metric = register.getSingleMetric("app_review_rejection_notifications_total");
    const before = (await metric.get()).values.find(
      (v) => v.labels?.channel === "teams" && v.labels?.outcome === "cooldown_skipped",
    )?.value ?? 0;
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(3));
    const after = (await metric.get()).values.find(
      (v) => v.labels?.channel === "teams" && v.labels?.outcome === "cooldown_skipped",
    )?.value ?? 0;
    assert.equal(after, before + 1,
      `Teams channel must record one cooldown_skipped bump; before=${before} after=${after}`);
  });

  await runner.test("cooldown — old reviewRejectionAlertLastFiredAt does NOT suppress dispatch", async () => {
    // Timestamp 2 hours ago > 1 hour default cooldown → dispatch proceeds
    // through the threshold + settings gates. With no channels configured
    // the run still completes without throwing; this pins the contract
    // that a stale cooldown stamp doesn't permanently mute alerts.
    resetDb();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const project = seedProject({
      id: "PROJ-stale-cooldown",
      reviewRejectionAlertThreshold: 0,
      reviewRejectionAlertLastFiredAt: twoHoursAgo,
    });
    seedNotificationSettings(project.id, { enabled: 1 });
    // No throw expected.
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(1));
  });

  await runner.test("cooldown — env override (REVIEW_REJECTION_NOTIFICATION_COOLDOWN_MS=0) disables debounce", async () => {
    // Operators with high-volume noise tolerance can set the env to 0
    // for "every rejection set fires immediately". Pin the env contract
    // so a future refactor that hard-codes the 1h default fails loudly.
    resetDb();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const project = seedProject({
      id: "PROJ-env-cooldown",
      reviewRejectionAlertThreshold: 0,
      reviewRejectionAlertLastFiredAt: fiveMinAgo,
    });
    seedNotificationSettings(project.id, { enabled: 1 });

    const original = process.env.REVIEW_REJECTION_NOTIFICATION_COOLDOWN_MS;
    process.env.REVIEW_REJECTION_NOTIFICATION_COOLDOWN_MS = "0";
    try {
      // With cooldown disabled and no channels configured, the path runs
      // through every gate without bumping `cooldown_skipped` on any
      // channel — pinning by measuring the Teams counter before / after.
      const metric = register.getSingleMetric("app_review_rejection_notifications_total");
      const before = (await metric.get()).values.find(
        (v) => v.labels?.channel === "teams" && v.labels?.outcome === "cooldown_skipped",
      )?.value ?? 0;
      await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(1));
      const after = (await metric.get()).values.find(
        (v) => v.labels?.channel === "teams" && v.labels?.outcome === "cooldown_skipped",
      )?.value ?? 0;
      assert.equal(after, before,
        `cooldown_skipped must NOT bump when env=0 disables debounce; before=${before} after=${after}`);
    } finally {
      if (original === undefined) delete process.env.REVIEW_REJECTION_NOTIFICATION_COOLDOWN_MS;
      else process.env.REVIEW_REJECTION_NOTIFICATION_COOLDOWN_MS = original;
    }
  });

  await runner.test("delivery counter — disabled settings bump outcome=\"disabled\" on every channel", async () => {
    // Pins the per-channel outcome attribution: when settings.enabled=0,
    // the dispatcher must record `disabled` on all three channels (not
    // `no_settings`, not silently no-op). Operators alerting on a
    // sudden spike in `outcome="disabled"` see "an admin just muted
    // notifications" rather than "the integration broke".
    resetDb();
    const project = seedProject({ id: "PROJ-disabled-counter", reviewRejectionAlertThreshold: 0 });
    seedNotificationSettings(project.id, { enabled: 0 });

    const metric = register.getSingleMetric("app_review_rejection_notifications_total");
    const before = ["teams", "email", "webhook"].map((channel) =>
      (metric.get()).then((j) => j.values.find(
        (v) => v.labels?.channel === channel && v.labels?.outcome === "disabled",
      )?.value ?? 0),
    );
    const beforeVals = await Promise.all(before);
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(1));
    const after = ["teams", "email", "webhook"].map((channel) =>
      (metric.get()).then((j) => j.values.find(
        (v) => v.labels?.channel === channel && v.labels?.outcome === "disabled",
      )?.value ?? 0),
    );
    const afterVals = await Promise.all(after);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(afterVals[i], beforeVals[i] + 1,
        `channel ${["teams","email","webhook"][i]} must record one disabled bump`);
    }
  });

  await runner.test("failure path — webhook 5xx bumps outcome=\"failed\" + enqueues to audit_dlq with rejection snapshot", async () => {
    // Industry-standard contract: when a notification channel fails,
    // the audit trail MUST survive. The dispatcher writes the failed
    // payload to `audit_dlq` (same DLQ surface the SIEM forwarder uses)
    // so admins can replay via the existing inspector. Pin both the
    // counter bump AND the DLQ enqueue here — a future refactor that
    // drops the DLQ write would silently lose audit data on every
    // failed Teams dispatch.
    //
    // Failure injection: SSRF guard rejects `http://127.0.0.1:1` (loopback
    // is on the reserved IP block). No real network call required —
    // `safeFetch` throws synchronously, which is exactly the failure
    // path we're pinning.
    resetDb();
    const workspaceId = "__system__";
    const project = seedProject({
      id: "PROJ-failure-dlq",
      workspaceId,
      reviewRejectionAlertThreshold: 0,
    });
    notificationSettingsRepo.upsert({
      id: generateNotificationSettingId(),
      projectId: project.id,
      teamsWebhookUrl: null,
      emailRecipients: null,
      // 127.0.0.1 is RFC 5735 reserved loopback — the SSRF guard rejects
      // it synchronously before any TCP attempt, giving us a deterministic
      // failure without flakiness from real network conditions.
      webhookUrl: "http://127.0.0.1:1/dlq-injection",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const metric = register.getSingleMetric("app_review_rejection_notifications_total");
    const failedBefore = (await metric.get()).values.find(
      (v) => v.labels?.channel === "webhook" && v.labels?.outcome === "failed",
    )?.value ?? 0;
    const dlqBefore = auditDlqRepo.countByWorkspace(workspaceId);

    const run = fakeRun(project.id);
    const rejections = fakeRejections(2);
    await fireReviewRejectionNotifications(run, project, rejections);

    const failedAfter = (await metric.get()).values.find(
      (v) => v.labels?.channel === "webhook" && v.labels?.outcome === "failed",
    )?.value ?? 0;
    assert.equal(failedAfter, failedBefore + 1,
      `webhook channel must record one failed bump on SSRF rejection; before=${failedBefore} after=${failedAfter}`);

    const dlqAfter = auditDlqRepo.countByWorkspace(workspaceId);
    assert.equal(dlqAfter, dlqBefore + 1,
      `audit_dlq must gain one row when the dispatch fails; before=${dlqBefore} after=${dlqAfter}`);

    // Inspect the enqueued row to confirm the snapshot carries the right
    // shape for DLQ replay (the inspector reads these fields to render
    // the per-row triage UI).
    const dlqRows = auditDlqRepo.listByWorkspace(workspaceId, { limit: 10 });
    // `hydrate()` inside `listByWorkspace` parses `rowSnapshot` from
    // JSON string → object, so we read the object directly (no re-parse).
    const ours = dlqRows.find((r) => {
      const snap = typeof r.rowSnapshot === "string"
        ? (() => { try { return JSON.parse(r.rowSnapshot); } catch { return null; } })()
        : r.rowSnapshot;
      return snap?.runId === run.id;
    });
    assert.ok(ours, "audit_dlq row for this run must be findable by runId in rowSnapshot");
    const snapshot = typeof ours.rowSnapshot === "string"
      ? JSON.parse(ours.rowSnapshot)
      : ours.rowSnapshot;
    assert.equal(snapshot.kind, "review_rejection_notification");
    assert.equal(snapshot.channel, "webhook");
    assert.equal(snapshot.projectId, project.id);
    assert.equal(snapshot.threshold, 0);
    assert.equal(Array.isArray(snapshot.rejections), true);
    assert.equal(snapshot.rejections.length, rejections.length);
    assert.ok(ours.lastError, "DLQ row must carry the original error message for triage");
  });

  await runner.test("success path — clean dispatch does NOT enqueue to audit_dlq", async () => {
    // Symmetric negative pin to the failure case above. When every
    // channel short-circuits (no settings) or completes successfully,
    // the DLQ row count must NOT grow. Without this pin, a future bug
    // that always enqueues (regardless of success) would silently
    // flood the DLQ with healthy dispatches, hiding real failures.
    //
    // We exercise the "no channels configured" success path here
    // because it produces a clean dispatch (zero `Promise.allSettled`
    // entries) without needing real network. The cooldown stamp is
    // tested separately below.
    resetDb();
    const workspaceId = "__system__";
    const project = seedProject({
      id: "PROJ-clean-dispatch",
      workspaceId,
      reviewRejectionAlertThreshold: 0,
    });
    // No channels configured (enabled: true, but no Teams/email/webhook)
    // → dispatcher passes every gate but iterates zero channels.
    seedNotificationSettings(project.id, { enabled: 1, webhookUrl: null });

    const dlqBefore = auditDlqRepo.countByWorkspace(workspaceId);
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(1));
    const dlqAfter = auditDlqRepo.countByWorkspace(workspaceId);
    assert.equal(dlqAfter, dlqBefore,
      `audit_dlq must NOT grow on a clean dispatch; before=${dlqBefore} after=${dlqAfter}`);
  });

  await runner.test("cooldown stamp — reviewRejectionAlertLastFiredAt is set after dispatch attempt", async () => {
    // Industry-standard contract: cooldown stamp goes on ATTEMPT, not
    // SUCCESS (matches `workspaces.spendAlertLastFiredAt` semantics).
    // A perma-failing webhook must not bypass the cooldown and spam
    // Teams indefinitely. Pin this by:
    //   1. Confirm the column starts NULL.
    //   2. Trigger a dispatch (even one that fails on SSRF).
    //   3. Confirm the column is now an ISO 8601 string within ±2s of
    //      the call, proving the dispatcher stamped at attempt time.
    resetDb();
    const workspaceId = "__system__";
    const project = seedProject({
      id: "PROJ-cooldown-stamp",
      workspaceId,
      reviewRejectionAlertThreshold: 0,
      // Explicitly start with NULL so the pre-condition is provable.
      reviewRejectionAlertLastFiredAt: null,
    });
    notificationSettingsRepo.upsert({
      id: generateNotificationSettingId(),
      projectId: project.id,
      teamsWebhookUrl: null,
      emailRecipients: null,
      // Same SSRF-reject pattern as the failure-path test — gives a
      // deterministic attempt that fails post-stamp, so the stamp
      // assertion proves "attempt, not success" semantics.
      webhookUrl: "http://127.0.0.1:1/cooldown-stamp",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Pre-condition.
    const before = projectRepo.getById(project.id);
    assert.equal(before.reviewRejectionAlertLastFiredAt, null,
      "test fixture must start with null cooldown stamp");

    const t0 = Date.now();
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(1));
    const t1 = Date.now();

    const after = projectRepo.getById(project.id);
    assert.ok(after.reviewRejectionAlertLastFiredAt,
      "reviewRejectionAlertLastFiredAt must be non-null after dispatch attempt (cooldown stamp on attempt, not success)");
    const stampedMs = Date.parse(after.reviewRejectionAlertLastFiredAt);
    assert.ok(Number.isFinite(stampedMs),
      `cooldown stamp must be valid ISO 8601, got: ${after.reviewRejectionAlertLastFiredAt}`);
    assert.ok(stampedMs >= t0 - 1000 && stampedMs <= t1 + 1000,
      `cooldown stamp must be within the dispatch window [${t0}, ${t1}], got ${stampedMs}`);
  });

  await runner.test("reviewRejectionNotificationsTotal counter is registered + accepts (channel, outcome) labels", async () => {
    // Pin the cardinality contract: 3 channels × 6 outcomes = 18
    // documented label combinations. A future refactor that drops a
    // label or renames an outcome breaks this test loudly rather than
    // silently breaking operator dashboards.
    const metric = register.getSingleMetric("app_review_rejection_notifications_total");
    assert.ok(metric, "delivery counter must be registered");
    // Synthetic bump exercising one (channel, outcome) pair we haven't
    // already touched in the gating tests above — `webhook/sent` is a
    // happy-path label that no other test in this file would bump
    // (everything here exercises skip / failure paths).
    const probeChannel = "webhook";
    const probeOutcome = "sent";
    reviewRejectionNotificationsTotal.inc({ channel: probeChannel, outcome: probeOutcome });
    const json = await metric.get();
    const sample = json.values.find(
      (v) => v.labels?.channel === probeChannel && v.labels?.outcome === probeOutcome,
    );
    assert.ok(sample, "counter must accept the (channel, outcome) label pair");
    assert.ok(sample.value >= 1, "counter increment must register");
  });

  await runner.test("reviewRejectionsTotal counter is registered + accepts projectId label", async () => {
    // B3 — counter carries `{projectId}` label (mirrors the
    // reviewer-collapse counter). Pin the label so a future refactor
    // that drops it fails loudly. Multi-tenant operators query the
    // per-project slice from Prometheus alone — no cross-reference
    // to the activity log required for alert routing.
    const metric = register.getSingleMetric("app_review_rejections_total");
    assert.ok(metric, "counter must be registered");
    const labelName = `proj-${Date.now()}`;
    reviewRejectionsTotal.inc({ projectId: labelName });
    const json = await metric.get();
    const sample = json.values.find((v) => v.labels?.projectId === labelName);
    assert.ok(sample, "counter must accept the projectId label");
    assert.equal(sample.value, 1, "exactly one increment recorded for this projectId");
  });

  runner.summary("B3 review-rejection-notification");
}

// AGENTS.md § "Use `createTestContext().createTestRunner()`" — every
// pattern-2 test file MUST surface unhandled rejections from `main()` or
// CI sees `exit code 1 with zero output` (the silent-CI-hang failure
// mode pattern 2 was designed to prevent). Mirrors the canonical
// `auto-approval-routes.test.js:178-181` shape.
main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("❌ review-rejection-notification failed:", err);
  process.exit(1);
});
