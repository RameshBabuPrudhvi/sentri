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

import * as notificationSettingsRepo from "../database/repositories/notificationSettingsRepo.js";
import { sendEmail } from "./emailSender.js";
import { formatLogLine } from "./logFormatter.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the base URL for deep links into the Sentri UI.
 *
 * @returns {string}
 */
function getAppUrl() {
  return process.env.APP_URL || process.env.CORS_ORIGIN || "http://localhost:3000";
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

  const res = await fetch(webhookUrl, {
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

  const res = await fetch(url, {
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

// ─── HTML escape (local — avoids importing from emailSender) ──────────────────

/**
 * Escape HTML special characters.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
