/**
 * @module aiProvider/spendAlert
 * @description B4.0.1 — Per-workspace spend-alert webhook delivery.
 *
 * Fires a Slack-compatible JSON POST to `workspaces.spendAlertWebhookUrl`
 * when spend crosses the alert threshold. 1-hour cooldown via
 * `workspaces.spendAlertLastFiredAt` (migration 052) so a sustained-
 * high-spend workspace doesn't flood the channel.
 *
 * Fail-open: every failure mode is swallowed and logged at warn. The
 * dispatcher MUST NOT block a real AI call because a Slack webhook is
 * down. The `console.warn` log line in the dispatcher still fires
 * unconditionally as a fallback.
 */
import { getDatabase } from "../database/sqlite.js";
import { safeFetch } from "../utils/ssrfGuard.js";
import { formatLogLine } from "../utils/logFormatter.js";
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
function getCooldownMs() {
  const raw = process.env.SPEND_ALERT_COOLDOWN_MS;
  if (!raw) return DEFAULT_COOLDOWN_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COOLDOWN_MS;
}
function shouldFire(lastFiredAt, now, cooldownMs) {
  if (!lastFiredAt) return true;
  const last = Date.parse(lastFiredAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= cooldownMs;
}
export const _shouldFireForTests = shouldFire;
function buildPayload(workspaceId, spend) {
  const exceededLine = spend.exceeded
    ? `*${spend.exceeded.toUpperCase()} CAP EXCEEDED — dispatch is BLOCKED.*`
    : `Spend has crossed *${spend.thresholdPct}%* of the configured cap. ` +
      "Dispatch continues; raise the cap or wait for the window to roll.";
  const dailyLine = Number.isFinite(spend.dailyCap) && spend.dailyCap > 0
    ? `Daily: $${(spend.dailySpent || 0).toFixed(4)} / $${spend.dailyCap.toFixed(2)}`
    : null;
  const monthlyLine = Number.isFinite(spend.monthlyCap) && spend.monthlyCap > 0
    ? `Monthly: $${(spend.monthlySpent || 0).toFixed(4)} / $${spend.monthlyCap.toFixed(2)}`
    : null;
  return {
    text: ["🚨 *Sentri AI spend alert*", `Workspace: \`${workspaceId}\``, exceededLine, dailyLine, monthlyLine].filter(Boolean).join("\n"),
    event: "ai.spend_alert",
    workspaceId,
    exceeded: spend.exceeded || null,
    dailySpent: spend.dailySpent,
    dailyCap: spend.dailyCap,
    monthlySpent: spend.monthlySpent,
    monthlyCap: spend.monthlyCap,
    thresholdPct: spend.thresholdPct,
    timestamp: new Date().toISOString(),
  };
}
export async function fireSpendAlert(workspaceId, spend) {
  if (!workspaceId || !spend) return { delivered: false, reason: "no_input" };
  let row;
  try {
    row = getDatabase().prepare(
      "SELECT spendAlertWebhookUrl, spendAlertLastFiredAt FROM workspaces WHERE id = ?",
    ).get(workspaceId);
  } catch (err) {
    console.warn(formatLogLine("warn", null, `[spendAlert] workspace lookup failed for ${workspaceId}: ${err.message}`));
    return { delivered: false, reason: "db_error" };
  }
  if (!row?.spendAlertWebhookUrl) return { delivered: false, reason: "no_webhook" };
  if (!shouldFire(row.spendAlertLastFiredAt, Date.now(), getCooldownMs())) {
    return { delivered: false, reason: "cooldown" };
  }
  let res;
  try {
    res = await safeFetch(row.spendAlertWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(workspaceId, spend)),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn(formatLogLine("warn", null, `[spendAlert] webhook delivery failed for ${workspaceId}: ${err.message}`));
    return { delivered: false, reason: "network_error" };
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    console.warn(formatLogLine("warn", null, `[spendAlert] webhook returned ${res.status} for ${workspaceId}: ${bodyText.slice(0, 200)}`));
    return { delivered: false, reason: `webhook_${res.status}` };
  }
  try {
    getDatabase().prepare("UPDATE workspaces SET spendAlertLastFiredAt = ? WHERE id = ?").run(new Date().toISOString(), workspaceId);
  } catch (err) {
    console.warn(formatLogLine("warn", null, `[spendAlert] cooldown stamp failed for ${workspaceId}: ${err.message}`));
  }
  return { delivered: true, reason: "delivered" };
}
