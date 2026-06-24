/**
 * @module utils/notifications
 * @description Failure notification dispatcher (FEA-001).
 *
 * Dispatches notifications to configured channels when a test run completes
 * with failures.  Supports three channels:
 *
 * 1. **Microsoft Teams** — Adaptive Card via incoming webhook.
 * 2. **Email** — HTML summary via the existing `emailSender.js` transport.
 * 3. **Generic webhook** — POST JSON payload to a user-configured URL.
 *
 * All dispatches are best-effort: errors are logged but never propagate
 * to the caller, so a failing notification never affects the run outcome.
 *
 * ### Usage
 * ```js
 * import { fireNotifications } from "../utils/notifications.js";
 * await fireNotifications(run, project);
 * ```
 */

import crypto from "node:crypto";
import * as notificationSettingsRepo from "../database/repositories/notificationSettingsRepo.js";
import * as workspaceSiemConfigRepo from "../database/repositories/workspaceSiemConfigRepo.js";
import * as auditDlqRepo from "../database/repositories/auditDlqRepo.js";
import { sendEmail, escapeHtml } from "./emailSender.js";
import { formatLogLine } from "./logFormatter.js";
import { safeFetch } from "./ssrfGuard.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the base URL for deep links into the Sentri UI.
 *
 * @returns {string}
 */
function getAppUrl() {
  if (process.env.APP_URL) return process.env.APP_URL;
  const corsOrigin = process.env.CORS_ORIGIN || "";
  return corsOrigin.split(",")[0].trim() || "http://localhost:3000";
}

/**
 * Build a deep link URL to a specific run detail page.
 *
 * @param {string} runId
 * @returns {string}
 */
function runDetailUrl(runId) {
  const base = getAppUrl().replace(/\/$/, "");
  const basePath = (process.env.APP_BASE_PATH || "/").replace(/\/$/, "");
  return `${base}${basePath}/runs/${runId}`;
}

/**
 * Extract failing test names from run results.
 *
 * @param {Object} run
 * @returns {string[]}
 */
function getFailingTestNames(run) {
  if (!Array.isArray(run.results)) return [];
  return run.results
    .filter(r => r.status === "failed")
    .map(r => r.testName || r.testId || "Unknown test")
    .slice(0, 10); // cap at 10 to avoid huge payloads
}

/**
 * Compute human-readable run duration.
 *
 * @param {Object} run
 * @returns {string}
 */
function formatDuration(run) {
  if (!run.duration) return "—";
  const secs = Math.round(run.duration / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
}

// ─── Channel dispatchers ──────────────────────────────────────────────────────

/**
 * Send a Microsoft Teams Adaptive Card via incoming webhook.
 *
 * @param {string} webhookUrl - Teams incoming webhook URL.
 * @param {Object} run        - Completed run object.
 * @param {Object} project    - Project object.
 * @returns {Promise<void>}
 */
async function sendTeamsNotification(webhookUrl, run, project) {
  const failingTests = getFailingTestNames(run);
  const deepLink = runDetailUrl(run.id);

  const card = {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          {
            type: "TextBlock",
            text: `🔴 Test Run Failed — ${project.name}`,
            weight: "Bolder",
            size: "Medium",
            wrap: true,
          },
          {
            type: "FactSet",
            facts: [
              { title: "Run", value: run.id },
              { title: "Passed", value: String(run.passed || 0) },
              { title: "Failed", value: String(run.failed || 0) },
              { title: "Total", value: String(run.total || 0) },
              { title: "Duration", value: formatDuration(run) },
            ],
          },
          ...(failingTests.length > 0 ? [{
            type: "TextBlock",
            text: `**Failing tests:**\n${failingTests.map(t => `- ${t}`).join("\n")}${failingTests.length >= 10 ? "\n- _(and more…)_" : ""}`,
            wrap: true,
            size: "Small",
          }] : []),
        ],
        actions: [
          {
            type: "Action.OpenUrl",
            title: "View Run Details",
            url: deepLink,
          },
        ],
      },
    }],
  };

  const res = await safeFetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Teams webhook returned ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Send a failure notification email to all configured recipients.
 *
 * @param {string} recipients - Comma-separated email addresses.
 * @param {Object} run        - Completed run object.
 * @param {Object} project    - Project object.
 * @returns {Promise<void>}
 */
async function sendEmailNotification(recipients, run, project) {
  const failingTests = getFailingTestNames(run);
  const deepLink = runDetailUrl(run.id);
  const duration = formatDuration(run);

  const subject = `[Sentri] ❌ ${run.failed} test${run.failed !== 1 ? "s" : ""} failed — ${project.name}`;

  const failList = failingTests.length > 0
    ? failingTests.map(t => `<li style="color:#dc2626;">${escapeHtml(t)}</li>`).join("")
    : "<li>No details available</li>";

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px;">
      <h2 style="margin: 0 0 16px; font-size: 20px; color: #0f172a;">Test Run Failed — ${escapeHtml(project.name)}</h2>
      <table style="width: 100%; border-collapse: collapse; margin: 0 0 16px; font-size: 14px; color: #475569;">
        <tr><td style="padding: 4px 8px 4px 0; font-weight: 600;">Run</td><td>${escapeHtml(run.id)}</td></tr>
        <tr><td style="padding: 4px 8px 4px 0; font-weight: 600;">Passed</td><td style="color: #16a34a;">${run.passed || 0}</td></tr>
        <tr><td style="padding: 4px 8px 4px 0; font-weight: 600;">Failed</td><td style="color: #dc2626;">${run.failed || 0}</td></tr>
        <tr><td style="padding: 4px 8px 4px 0; font-weight: 600;">Total</td><td>${run.total || 0}</td></tr>
        <tr><td style="padding: 4px 8px 4px 0; font-weight: 600;">Duration</td><td>${escapeHtml(duration)}</td></tr>
      </table>
      <p style="margin: 0 0 8px; font-size: 14px; font-weight: 600; color: #0f172a;">Failing tests:</p>
      <ul style="margin: 0 0 20px; padding-left: 20px; font-size: 13px; line-height: 1.6;">${failList}</ul>
      <a href="${escapeHtml(deepLink)}" style="display: inline-block; padding: 10px 24px; background: #6366f1; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">
        View Run Details
      </a>
    </div>
  `;

  const text = [
    `Test Run Failed — ${project.name}`,
    `Run: ${run.id} | Passed: ${run.passed || 0} | Failed: ${run.failed || 0} | Total: ${run.total || 0} | Duration: ${duration}`,
    `Failing tests: ${failingTests.join(", ")}`,
    `Details: ${deepLink}`,
  ].join("\n\n");

  const emails = recipients.split(",").map(e => e.trim()).filter(Boolean);
  for (const to of emails) {
    await sendEmail({ to, subject, html, text });
  }
}

/**
 * Send a generic webhook notification (POST JSON).
 *
 * @param {string} url     - Webhook URL.
 * @param {Object} run     - Completed run object.
 * @param {Object} project - Project object.
 * @returns {Promise<void>}
 */
async function sendWebhookNotification(url, run, project) {
  const payload = {
    event: "run.failed",
    runId: run.id,
    projectId: project.id,
    projectName: project.name,
    status: run.status,
    passed: run.passed || 0,
    failed: run.failed || 0,
    total: run.total || 0,
    duration: run.duration || null,
    failingTests: getFailingTestNames(run),
    detailUrl: runDetailUrl(run.id),
    timestamp: new Date().toISOString(),
  };

  const res = await safeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Webhook returned ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fire all configured notification channels for a completed run.
 *
 * Only dispatches when:
 * 1. The run has failures (`run.failed > 0`).
 * 2. The project has notification settings configured and enabled.
 *
 * All dispatches are best-effort — errors are logged but never thrown.
 *
 * @param {Object} run     - The completed run object.
 * @param {Object} project - The project `{ id, name, url }`.
 * @returns {Promise<void>}
 */
export async function fireNotifications(run, project) {
  // Only notify on failures
  if (!run.failed || run.failed <= 0) return;

  let settings;
  try {
    settings = notificationSettingsRepo.getByProjectId(project.id);
  } catch (err) {
    console.warn(formatLogLine("warn", null,
      `[notifications] Failed to read settings for project ${project.id}: ${err.message}`));
    return;
  }

  if (!settings || !settings.enabled) return;

  const dispatches = [];

  // Microsoft Teams
  if (settings.teamsWebhookUrl) {
    dispatches.push(
      sendTeamsNotification(settings.teamsWebhookUrl, run, project)
        .then(() => console.log(formatLogLine("info", null,
          `[notifications] Teams notification sent for ${run.id}`)))
        .catch(err => console.warn(formatLogLine("warn", null,
          `[notifications] Teams notification failed for ${run.id}: ${err.message}`)))
    );
  }

  // Email
  if (settings.emailRecipients) {
    dispatches.push(
      sendEmailNotification(settings.emailRecipients, run, project)
        .then(() => console.log(formatLogLine("info", null,
          `[notifications] Email notification sent for ${run.id}`)))
        .catch(err => console.warn(formatLogLine("warn", null,
          `[notifications] Email notification failed for ${run.id}: ${err.message}`)))
    );
  }

  // Generic webhook
  if (settings.webhookUrl) {
    dispatches.push(
      sendWebhookNotification(settings.webhookUrl, run, project)
        .then(() => console.log(formatLogLine("info", null,
          `[notifications] Webhook notification sent for ${run.id}`)))
        .catch(err => console.warn(formatLogLine("warn", null,
          `[notifications] Webhook notification failed for ${run.id}: ${err.message}`)))
    );
  }

  await Promise.allSettled(dispatches);
}

// ─── B3 (AUDIT-ROADMAP) — Review-rejection escalation ────────────────────────

/**
 * Build the deep link URL to a specific test detail page. Mirrors the
 * shape of `runDetailUrl` so the two surfaces compose into the same
 * email / Teams card layout.
 *
 * @param {string} projectId
 * @param {string} testId
 * @returns {string}
 */
function testDetailUrl(projectId, testId) {
  const base = getAppUrl().replace(/\/$/, "");
  const basePath = (process.env.APP_BASE_PATH || "/").replace(/\/$/, "");
  return `${base}${basePath}/projects/${projectId}/tests/${testId}`;
}

/**
 * B3 (AUDIT-ROADMAP Bundle 3) — fire FEA-001 channels for tests that
 * the reviewer↔author loop discarded via `ReviewRejection`. Respects
 * the per-project `reviewRejectionAlertThreshold`:
 *
 *   • `null` / `0` → notify on any rejection (default).
 *   • positive `N` → notify only when `rejections.length >= N`.
 *   • `-1`         → opt-out, never notify.
 *
 * Uses the same Teams / email / webhook channels as `fireNotifications`
 * — operators don't get a second integration matrix to configure. The
 * dispatcher is best-effort: every channel error is caught and logged.
 *
 * @param {Object}   run
 * @param {Object}   project
 * @param {Object[]} rejections - `run.reviewRejectedTests[]`.
 * @returns {Promise<void>}
 */
export async function fireReviewRejectionNotifications(run, project, rejections) {
  if (!Array.isArray(rejections) || rejections.length === 0) return;

  // Lazy-loaded so this module's top-level import graph stays minimal.
  // The metrics counter is registered at module load via `utils/metrics.js`;
  // we import the named export here to avoid circular surface area with
  // `agentLoop.js` / `feedbackLoop.js` (both transitively touch this file
  // through the rest of the dispatch chain).
  const { reviewRejectionNotificationsTotal } = await import("./metrics.js");
  // Helper: bump the delivery counter best-effort. Wrapped so a metric-
  // registry hiccup never breaks the dispatch path.
  const bump = (channel, outcome) => {
    try { reviewRejectionNotificationsTotal.inc({ channel, outcome }); } catch { /* best-effort */ }
  };

  // Threshold gate. Stored as INTEGER; `null` defaults to 0 (always).
  const threshold = project?.reviewRejectionAlertThreshold ?? 0;
  if (threshold < 0) {
    // Operator opt-out — record the skip so dashboards can show "this
    // project deliberately mutes alerts" rather than the count looking
    // like a delivery failure.
    bump("teams", "threshold_skipped");
    bump("email", "threshold_skipped");
    bump("webhook", "threshold_skipped");
    return;
  }
  if (threshold > 0 && rejections.length < threshold) {
    bump("teams", "threshold_skipped");
    bump("email", "threshold_skipped");
    bump("webhook", "threshold_skipped");
    return;
  }

  // B3 — per-project cooldown debounce. Mirrors the existing
  // `workspaces.spendAlertLastFiredAt` pattern in `aiProvider/spendAlert.js`.
  // Default 1 hour; env-tunable for ops who want tighter or looser noise
  // floors. Cooldown is per-project (not per-channel) because the rejection
  // signal itself is project-scoped — three channels firing once each on
  // the same project within an hour is one operator-visible event, not
  // three.
  const cooldownMs = Number.parseInt(process.env.REVIEW_REJECTION_NOTIFICATION_COOLDOWN_MS, 10);
  const effectiveCooldownMs = Number.isFinite(cooldownMs) && cooldownMs >= 0
    ? cooldownMs
    : 60 * 60 * 1000;
  if (effectiveCooldownMs > 0 && project.reviewRejectionAlertLastFiredAt) {
    const lastFiredMs = Date.parse(project.reviewRejectionAlertLastFiredAt);
    if (Number.isFinite(lastFiredMs) && Date.now() - lastFiredMs < effectiveCooldownMs) {
      bump("teams", "cooldown_skipped");
      bump("email", "cooldown_skipped");
      bump("webhook", "cooldown_skipped");
      console.log(formatLogLine("info", null,
        `[notifications] Review-rejection notification suppressed for project ${project.id} (cooldown active until ${new Date(lastFiredMs + effectiveCooldownMs).toISOString()})`));
      return;
    }
  }

  let settings;
  try {
    settings = notificationSettingsRepo.getByProjectId(project.id);
  } catch (err) {
    console.warn(formatLogLine("warn", null,
      `[notifications] Failed to read settings for project ${project.id}: ${err.message}`));
    bump("teams", "no_settings");
    bump("email", "no_settings");
    bump("webhook", "no_settings");
    return;
  }
  if (!settings) {
    bump("teams", "no_settings");
    bump("email", "no_settings");
    bump("webhook", "no_settings");
    return;
  }
  if (!settings.enabled) {
    bump("teams", "disabled");
    bump("email", "disabled");
    bump("webhook", "disabled");
    return;
  }

  const deepLink = runDetailUrl(run.id);
  const subjectShort = `${rejections.length} test${rejections.length !== 1 ? "s" : ""} discarded by review — ${project.name}`;
  const dispatches = [];

  // Microsoft Teams — Adaptive Card with one fact row per rejection
  // (capped at 10 to keep payload size bounded; same cap as the
  // failure-notification path).
  if (settings.teamsWebhookUrl) {
    const cappedRejections = rejections.slice(0, 10);
    const card = {
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: `🟠 ${subjectShort}`,
              weight: "Bolder",
              size: "Medium",
              wrap: true,
            },
            {
              type: "FactSet",
              facts: [
                { title: "Run", value: run.id },
                { title: "Discarded", value: String(rejections.length) },
                { title: "Threshold", value: String(threshold) },
              ],
            },
            {
              type: "TextBlock",
              text: `**Discarded tests:**\n${cappedRejections.map(r =>
                `- ${r.testName || r.testId || "Unknown"} (${r.failureCategory}, ${r.roundsCompleted} round${r.roundsCompleted === 1 ? "" : "s"})`,
              ).join("\n")}${rejections.length > 10 ? "\n- _(and more…)_" : ""}`,
              wrap: true,
              size: "Small",
            },
          ],
          actions: [{ type: "Action.OpenUrl", title: "View Run Details", url: deepLink }],
        },
      }],
    };
    dispatches.push(
      _deliverChannel({
        channel: "teams",
        send: () => safeFetch(settings.teamsWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(card),
          signal: AbortSignal.timeout(10_000),
        }).then((res) => {
          if (!res.ok) throw new Error(`Teams webhook returned ${res.status}`);
        }),
        workspaceId: project.workspaceId || null,
        run,
        project,
        rejections,
        bump,
      }),
    );
  }

  // Email — list of rejected tests with deep links to TestDetail.
  if (settings.emailRecipients) {
    const subject = `[Sentri] 🟠 ${subjectShort}`;
    const items = rejections.slice(0, 20).map(r => `<li>${escapeHtml(r.testName || r.testId || "Unknown")} <span style="color:#64748b;">— ${escapeHtml(r.failureCategory || "")} after ${r.roundsCompleted} round${r.roundsCompleted === 1 ? "" : "s"}</span>${r.testId && project.id ? ` <a href="${escapeHtml(testDetailUrl(project.id, r.testId))}" style="color:#6366f1;">[view]</a>` : ""}</li>`).join("");
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px;">
        <h2 style="margin: 0 0 16px; font-size: 20px; color: #0f172a;">${escapeHtml(subjectShort)}</h2>
        <p style="margin: 0 0 12px; font-size: 14px; color: #475569;">The reviewer↔author loop terminated with ReviewRejection on the following test${rejections.length === 1 ? "" : "s"}; they were not promoted to draft. Triage in TestDetail to inspect the agent conversation thread.</p>
        <ul style="margin: 0 0 20px; padding-left: 20px; font-size: 13px; line-height: 1.6;">${items}</ul>
        <a href="${escapeHtml(deepLink)}" style="display: inline-block; padding: 10px 24px; background: #6366f1; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">View Run Details</a>
      </div>
    `;
    const text = [
      subjectShort,
      `Run: ${run.id} | Discarded: ${rejections.length} | Threshold: ${threshold}`,
      `Tests: ${rejections.slice(0, 10).map(r => r.testName || r.testId).join(", ")}`,
      `Details: ${deepLink}`,
    ].join("\n\n");
    const emails = settings.emailRecipients.split(",").map(e => e.trim()).filter(Boolean);
    for (const to of emails) {
      dispatches.push(
        _deliverChannel({
          channel: "email",
          send: () => sendEmail({ to, subject, html, text }),
          workspaceId: project.workspaceId || null,
          run,
          project,
          rejections,
          bump,
          extraContext: { recipient: to },
        }),
      );
    }
  }

  // Generic webhook — JSON payload with full rejection list (no UI cap;
  // downstream consumers parse JSON, not Adaptive Cards).
  if (settings.webhookUrl) {
    const payload = {
      event: "test.review_rejected",
      runId: run.id,
      projectId: project.id,
      projectName: project.name,
      workspaceId: project.workspaceId || null,
      threshold,
      reviewRejectedTests: rejections,
      detailUrl: deepLink,
      timestamp: new Date().toISOString(),
    };
    dispatches.push(
      _deliverChannel({
        channel: "webhook",
        send: () => safeFetch(settings.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        }).then((res) => {
          if (!res.ok) throw new Error(`Webhook returned ${res.status}`);
        }),
        workspaceId: project.workspaceId || null,
        run,
        project,
        rejections,
        bump,
      }),
    );
  }

  await Promise.allSettled(dispatches);

  // B3 — stamp the cooldown timestamp ONLY when at least one channel
  // attempted delivery. If every channel short-circuited (no settings,
  // disabled, threshold/cooldown skip — handled above already) we
  // never reach this line. If every configured channel FAILED we still
  // stamp: the operator's intent to be notified was honoured, the
  // failure is in the DLQ for replay, and we don't want a perma-failing
  // webhook to bypass the cooldown and spam Teams indefinitely.
  // Industry pattern: stamp on "attempt", not "success" (matches
  // `workspaces.spendAlertLastFiredAt` semantics).
  if (dispatches.length > 0) {
    try {
      // Named-export dynamic import; namespace object exposes `update`.
      const projectRepo = await import("../database/repositories/projectRepo.js");
      if (typeof projectRepo.update === "function") {
        projectRepo.update(project.id, {
          reviewRejectionAlertLastFiredAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      // Cooldown bookkeeping is best-effort. Worst case: next rejection
      // round fires another notification within the cooldown window —
      // annoying but not data-loss. Mirrors the cooldown-write contract
      // in `spendAlert.js`.
      console.warn(formatLogLine("warn", null,
        `[notifications] Failed to stamp reviewRejectionAlertLastFiredAt for project ${project.id}: ${err.message}`));
    }
  }
}

// ── B3 channel-dispatch helper (extracted for cohesion) ─────────────────────
//
// Single delivery surface for every B3 notification channel. Wraps the
// per-channel `send()` closure with:
//   1. Per-channel delivery counter bumps (`sent` / `failed`).
//   2. Structured log line on success + on failure (operators can grep
//      `[notifications] <channel> review-rejection ...` to triage).
//   3. DLQ enqueue on failure so a transient Teams outage doesn't lose
//      the audit-trail of "we tried to alert about run X but couldn't".
//      Replay surface is the existing SEC-007 audit-log DLQ inspector;
//      same enqueue contract as `dispatchSiemEvent` failures.
//
// `extraContext` lets the caller pass channel-specific metadata (e.g.
// the email recipient) into the DLQ snapshot for triage. Bounded by
// `auditDlqRepo.enqueue`'s row size limits.
async function _deliverChannel({
  channel, send, workspaceId, run, project, rejections, bump, extraContext = {},
}) {
  try {
    await send();
    bump(channel, "sent");
    console.log(formatLogLine("info", null,
      `[notifications] ${channel} review-rejection notification sent for ${run.id}`));
  } catch (err) {
    bump(channel, "failed");
    const msg = err?.message || String(err);
    console.warn(formatLogLine("warn", null,
      `[notifications] ${channel} review-rejection notification failed for ${run.id}: ${msg}`));
    // DLQ enqueue — best-effort. The `rowSnapshot` matches the JSON
    // webhook payload shape so DLQ replay can re-dispatch by feeding
    // the row back through `fireReviewRejectionNotifications` with
    // `cooldown_skipped` semantics bypassed. Bounded payload size
    // (capped at first 50 rejections to stay under typical DLQ row
    // limits even on pathological discards).
    try {
      // `auditDlqRepo` uses named exports — dynamic import returns the
      // namespace object directly. Match the same shape the SIEM
      // forwarder above uses (`import * as auditDlqRepo from ...`).
      const auditDlqRepo = await import("../database/repositories/auditDlqRepo.js");
      if (typeof auditDlqRepo.enqueue === "function" && workspaceId) {
        auditDlqRepo.enqueue({
          workspaceId,
          rowSnapshot: {
            kind: "review_rejection_notification",
            channel,
            runId: run.id,
            projectId: project.id,
            projectName: project.name,
            threshold: project?.reviewRejectionAlertThreshold ?? 0,
            rejections: rejections.slice(0, 50),
            ...extraContext,
            failedAt: new Date().toISOString(),
          },
          lastError: msg,
        });
      }
    } catch (dlqErr) {
      // DLQ enqueue itself failed — log loudly so ops see "the audit
      // trail of failed notifications is itself broken". Doesn't throw.
      console.error(formatLogLine("error", null,
        `[notifications] DLQ enqueue failed for ${channel} notification on run ${run.id}: ${dlqErr?.message || dlqErr} (original error: ${msg})`));
    }
  }
}

// ─── SEC-007 Part C: SIEM audit-log forwarder ─────────────────────────────────

/**
 * Sleep for `ms` milliseconds. Used by the SIEM retry loop's exponential
 * backoff schedule.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 * @private
 */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the HMAC-SHA256 signature of an NDJSON body.
 *
 * SIEM operators verify this header on their ingest endpoint to confirm
 * the event came from the configured workspace's Sentri instance.
 *
 *   X-Sentri-Audit-Signature: sha256=<hex(hmac_sha256(secret, body))>
 *
 * @param {string} secret - Per-workspace HMAC secret (plaintext).
 * @param {string} body   - The NDJSON body string.
 * @returns {string}        sha256=<hex digest>
 * @private
 */
function _hmacSignature(secret, body) {
  const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
}

/**
 * Determine whether an HTTP response status should trigger a retry.
 *
 * - 5xx server errors → retry (transient)
 * - 408 Request Timeout, 429 Too Many Requests → retry (back-pressure)
 * - 4xx (other) → DO NOT retry; the SIEM target rejected our payload
 *   shape or our auth, so retrying with the same bytes won't help.
 *   The DLQ inspector + admin replay path is the recovery surface for
 *   config-issue failures.
 *
 * @param {number} status
 * @returns {boolean}
 * @private
 */
function _isRetryableStatus(status) {
  if (status >= 500) return true;
  if (status === 408 || status === 429) return true;
  return false;
}

/**
 * SEC-007 Part C — forward a single audit row to the workspace's configured
 * SIEM target.
 *
 * Lookup chain:
 *   1. Read per-workspace config via `workspaceSiemConfigRepo.getDecrypted`.
 *      If no row, or row has `enabled = false`, return immediately (no-op).
 *   2. POST the row as one NDJSON line with:
 *        Content-Type: application/x-ndjson
 *        X-Sentri-Audit-Signature: sha256=<hex(hmac(secret, body))>
 *        ... + any configured custom headers (e.g. Splunk HEC token).
 *   3. Retry on 5xx / 408 / 429 with backoff (immediate, then 1s, then 2s).
 *   4. After 3 attempts, enqueue the row in `audit_dlq` so an admin can
 *      replay it via the AuditLog DLQ inspector.
 *
 * Fire-and-forget contract: this function NEVER throws to the caller.
 * It's invoked from `logActivity` after every audit INSERT, and a SIEM
 * outage MUST NOT block the originating request. Failures land in the
 * DLQ; persistent outages surface as a non-empty DLQ count in the UI.
 *
 * @param {string} workspaceId - The workspace whose SIEM config to load.
 * @param {Object} row         - The activity row that was just persisted.
 * @param {Object} [opts]
 * @param {boolean} [opts.skipDlqOnFailure=false] - When true, a failed
 *   dispatch will NOT enqueue a fresh DLQ row. Used by the admin DLQ
 *   replay path so that retrying an existing DLQ row doesn't create a
 *   duplicate row each time it fails — the route handler manages the
 *   original row's `attempts` counter via `auditDlqRepo.incrementAttempts`
 *   instead. Default `false` preserves the original fire-and-forget
 *   contract for the `logActivity` dispatch path.
 * @returns {Promise<Object>} `{ ok: boolean, attempts?: number, lastError?: string }`
 */
export async function dispatchSiemEvent(workspaceId, row, opts = {}) {
  if (!workspaceId || !row) return { ok: false, lastError: "missing workspaceId or row" };

  let cfg;
  try {
    cfg = workspaceSiemConfigRepo.getDecrypted(workspaceId);
  } catch (err) {
    // Reading the config shouldn't fail under normal conditions, but if
    // the DB is locked / decryption errors / etc., treat as not-configured.
    // Logging at warn (not error) because this is best-effort and the row
    // is already safely persisted in `activities`.
    console.warn(formatLogLine("warn", null,
      `[siem] Failed to load config for ${workspaceId}: ${err.message}`));
    return { ok: false, lastError: err.message };
  }

  if (!cfg || !cfg.enabled || !cfg.targetUrl) {
    // Not configured or disabled — silent no-op (the audit row is still
    // safely in the DB; SIEM forwarding is an optional extension).
    return { ok: false, lastError: "siem-not-configured" };
  }

  // NDJSON one-line body. The verifying side feeds the exact bytes
  // received into HMAC-SHA256 — any whitespace change here would break
  // verification, so we serialise the row exactly once.
  const body = JSON.stringify(row) + "\n";
  const signature = _hmacSignature(cfg.hmacSecret, body);

  // SEC-007: spread custom headers FIRST so the system-controlled integrity
  // headers (`Content-Type`, `X-Sentri-Audit-Signature`) can never be
  // overridden by an admin's `cfg.headers`. A malicious or careless admin
  // setting `headers: { "X-Sentri-Audit-Signature": "sha256=0…0" }` would
  // otherwise silently strip HMAC verification at the SIEM target. The PUT
  // route validator also rejects reserved header names defensively.
  const headers = {
    ...(cfg.headers || {}),
    "Content-Type": "application/x-ndjson",
    "X-Sentri-Audit-Signature": signature,
  };

  // 3 attempts at 0s, 1s, 2s (cumulative 3s). `safeFetch` enforces SSRF
  // protection on the target URL (same guard used by notification webhooks)
  // so an attacker configuring a malicious SIEM URL (169.254.169.254, etc.)
  // can't pivot through Sentri to reach cloud metadata endpoints.
  //
  // First attempt fires immediately (no backoff); subsequent attempts back
  // off exponentially. Aligning the loop and array indices avoids an
  // off-by-one that would otherwise add a spurious 1-second delay before
  // every initial dispatch.
  const backoffMs = [0, 1000, 2000];
  let lastError = "unknown";
  let attempts = 0;

  for (let i = 0; i < 3; i++) {
    attempts = i + 1;
    if (backoffMs[i] > 0) await _sleep(backoffMs[i]);
    try {
      const res = await safeFetch(cfg.targetUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        return { ok: true, attempts };
      }
      // Non-2xx — decide whether to keep trying or bail to DLQ.
      const bodyText = await res.text().catch(() => "");
      lastError = `HTTP ${res.status}: ${bodyText.slice(0, 200)}`;
      if (!_isRetryableStatus(res.status)) {
        // 4xx config issue — don't waste budget retrying. Go straight to DLQ.
        break;
      }
    } catch (err) {
      // Network / DNS / TLS / SSRF rejection / timeout. All retryable.
      lastError = err.message || String(err);
    }
  }

  // All retries exhausted (or 4xx short-circuit). Enqueue for admin replay
  // — unless the caller is itself the admin replay path (`skipDlqOnFailure`),
  // in which case re-enqueuing here would create a duplicate of the very
  // DLQ row the caller is retrying. The replay route handles bookkeeping
  // by calling `auditDlqRepo.incrementAttempts` on the original row.
  if (!opts.skipDlqOnFailure) {
    try {
      auditDlqRepo.enqueue({
        workspaceId,
        rowSnapshot: row,
        lastError,
      });
      console.warn(formatLogLine("warn", null,
        `[siem] Dispatch failed after ${attempts} attempt(s) for ws=${workspaceId} row=${row.id || "?"} — enqueued to DLQ: ${lastError}`));
    } catch (dlqErr) {
      // DLQ failure is a P1 — the audit row is safely persisted but its
      // dispatch trace is now lost. Log loudly so operators can investigate.
      console.error(formatLogLine("error", null,
        `[siem] DLQ enqueue failed for ws=${workspaceId} row=${row.id || "?"}: ${dlqErr.message} (original dispatch error: ${lastError})`));
    }
  }

  return { ok: false, attempts, lastError };
}
