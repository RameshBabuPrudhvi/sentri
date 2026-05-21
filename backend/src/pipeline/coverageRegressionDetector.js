/**
 * @module pipeline/coverageRegressionDetector
 * @description AUTO-009i — Coverage regression detection + notification dispatch.
 *
 * Compares the current run's `coveragePct` against a rolling baseline
 * (the prior coverage-enabled run's `coveragePct`) and fires a notification
 * through the FEA-001 pipeline when the drop exceeds the project's
 * configured threshold (`coverageRegressionThresholdPct`, default: disabled).
 *
 * ### Design
 *
 * - Pure detection function (`detectCoverageRegression`) — no I/O, testable.
 * - Dispatch function (`fireCoverageRegressionAlert`) — calls the same
 *   channel dispatchers as `fireNotifications` (Teams / email / webhook)
 *   with a coverage-specific payload shape.
 * - Activity row `coverage.regression` emitted for SEC-007 audit trail.
 *
 * Best-effort: never throws. A regression-alert failure must never block
 * run finalization.
 *
 * @example
 *   const regression = detectCoverageRegression(run.coverageSummary, priorRunCoverage, project);
 *   if (regression) await fireCoverageRegressionAlert(regression, run, project);
 */

import { formatLogLine } from "../utils/logFormatter.js";
import { logActivity } from "../utils/activityLogger.js";
import * as notificationSettingsRepo from "../database/repositories/notificationSettingsRepo.js";
import { safeFetch } from "../utils/ssrfGuard.js";
import { sendEmail, escapeHtml } from "../utils/emailSender.js";

/**
 * Detect whether coverage regressed past the project's threshold.
 *
 * @param {Object|null} currentSummary   - This run's `coverageSummary`.
 * @param {Object|null} priorSummary     - Previous coverage-enabled run's summary.
 * @param {Object}      project          - Must carry `coverageRegressionThresholdPct`.
 * @returns {Object|null} `{ dropPct, currentPct, priorPct, thresholdPct }` or null.
 */
export function detectCoverageRegression(currentSummary, priorSummary, project) {
  if (!currentSummary || !priorSummary) return null;
  if (!Number.isFinite(currentSummary.coveragePct) || !Number.isFinite(priorSummary.coveragePct)) return null;

  // Threshold is per-project, stored on the project row. When unset (null /
  // undefined / 0), regression alerting is disabled — the operator hasn't
  // opted in. Default disabled so existing projects don't get surprise alerts.
  const threshold = Number(project?.coverageRegressionThresholdPct);
  if (!Number.isFinite(threshold) || threshold <= 0) return null;

  const currentPct = Number((currentSummary.coveragePct * 100).toFixed(2));
  const priorPct = Number((priorSummary.coveragePct * 100).toFixed(2));
  const dropPct = Number((priorPct - currentPct).toFixed(2));

  if (dropPct <= threshold) return null;

  return { dropPct, currentPct, priorPct, thresholdPct: threshold };
}

/**
 * Build the app URL for deep links.
 * @returns {string}
 */
function getAppUrl() {
  if (process.env.APP_URL) return process.env.APP_URL;
  const corsOrigin = process.env.CORS_ORIGIN || "";
  return corsOrigin.split(",")[0].trim() || "http://localhost:3000";
}

function runDetailUrl(runId) {
  const base = getAppUrl().replace(/\/$/, "");
  const basePath = (process.env.APP_BASE_PATH || "/").replace(/\/$/, "");
  return `${base}${basePath}/runs/${runId}`;
}

/**
 * Fire coverage regression alerts through configured notification channels
 * and emit a `coverage.regression` audit row.
 *
 * Uses the same notification settings as `fireNotifications` (FEA-001) —
 * Teams, email, generic webhook. Best-effort: never throws.
 *
 * @param {Object} regression - Output of `detectCoverageRegression`.
 * @param {Object} run
 * @param {Object} project
 * @returns {Promise<void>}
 */
export async function fireCoverageRegressionAlert(regression, run, project) {
  if (!regression || !run || !project) return;

  // Audit trail — SEC-007 compatible.
  try {
    logActivity({
      type: "coverage.regression",
      projectId: project.id,
      projectName: project.name,
      workspaceId: project.workspaceId,
      detail: `Coverage dropped ${regression.dropPct}% (from ${regression.priorPct}% to ${regression.currentPct}%), threshold ${regression.thresholdPct}%`,
      meta: {
        runId: run.id,
        dropPct: regression.dropPct,
        currentPct: regression.currentPct,
        priorPct: regression.priorPct,
        thresholdPct: regression.thresholdPct,
      },
    });
  } catch { /* best-effort */ }

  // Load notification settings — same as fireNotifications.
  let settings;
  try {
    settings = notificationSettingsRepo.getByProjectId(project.id);
  } catch {
    return;
  }
  if (!settings || !settings.enabled) return;

  const deepLink = runDetailUrl(run.id);
  const headline = `📉 Coverage regression — ${project.name}`;
  const body = `Coverage dropped **${regression.dropPct}%** (from ${regression.priorPct}% → ${regression.currentPct}%). Threshold: ${regression.thresholdPct}%.`;

  const dispatches = [];

  // Teams
  if (settings.teamsWebhookUrl) {
    dispatches.push((async () => {
      try {
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
                { type: "TextBlock", text: headline, weight: "Bolder", size: "Medium", wrap: true },
                { type: "TextBlock", text: body, wrap: true, size: "Small" },
                { type: "FactSet", facts: [
                  { title: "Run", value: run.id },
                  { title: "Prior", value: `${regression.priorPct}%` },
                  { title: "Current", value: `${regression.currentPct}%` },
                  { title: "Drop", value: `${regression.dropPct}%` },
                ]},
              ],
              actions: [{ type: "Action.OpenUrl", title: "View Run", url: deepLink }],
            },
          }],
        };
        await safeFetch(settings.teamsWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(card),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        console.warn(formatLogLine("warn", null, `[coverage-regression] Teams alert failed: ${err.message}`));
      }
    })());
  }

  // Email
  if (settings.emailRecipients) {
    dispatches.push((async () => {
      try {
        const subject = `[Sentri] ${headline}`;
        const html = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
          <h2 style="color:#dc2626;">${escapeHtml(headline)}</h2>
          <p>${escapeHtml(body.replace(/\*\*/g, ""))}</p>
          <p>Run: <code>${escapeHtml(run.id)}</code></p>
          <a href="${escapeHtml(deepLink)}" style="display:inline-block;padding:10px 24px;background:#6366f1;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">View Run</a>
        </div>`;
        const emails = settings.emailRecipients.split(",").map(e => e.trim()).filter(Boolean);
        for (const to of emails) {
          await sendEmail({ to, subject, html, text: `${headline}\n${body}\n${deepLink}` });
        }
      } catch (err) {
        console.warn(formatLogLine("warn", null, `[coverage-regression] Email alert failed: ${err.message}`));
      }
    })());
  }

  // Webhook
  if (settings.webhookUrl) {
    dispatches.push((async () => {
      try {
        await safeFetch(settings.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "coverage.regression",
            runId: run.id,
            projectId: project.id,
            projectName: project.name,
            dropPct: regression.dropPct,
            currentPct: regression.currentPct,
            priorPct: regression.priorPct,
            thresholdPct: regression.thresholdPct,
            detailUrl: deepLink,
            timestamp: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        console.warn(formatLogLine("warn", null, `[coverage-regression] Webhook alert failed: ${err.message}`));
      }
    })());
  }

  await Promise.allSettled(dispatches);
}
