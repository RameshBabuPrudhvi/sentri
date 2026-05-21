import crypto from "crypto";
import { getDatabase } from "../database/sqlite.js";

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;

// B2.5 — Exported for direct unit testing. Production callers should use
// `logRequest()` which handles storage-mode gating + async write; this
// is the bare redaction primitive that the storage pipeline applies in
// `"redacted"` mode.
export function redactText(text, customRules = []) {
  if (!text) return null;
  let out = String(text);
  out = out.replace(EMAIL_RE, "[REDACTED_EMAIL]");
  out = out.replace(PHONE_RE, "[REDACTED_PHONE]");
  out = out.replace(SSN_RE, "[REDACTED_SSN]");
  out = out.replace(CARD_RE, "[REDACTED_CARD]");
  for (const rule of customRules) {
    try {
      const re = new RegExp(rule.pattern, rule.flags || "g");
      out = out.replace(re, rule.replacement || "[REDACTED_CUSTOM]");
    } catch {}
  }
  return out;
}

export function hashPrompt(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

export function logRequest(entry = {}) {
  setImmediate(() => {
    try {
      const mode = entry.storageMode || "none";
      const prompt = String(entry.prompt || "");
      const response = String(entry.response || "");
      const customRules = Array.isArray(entry.customRedactionRules) ? entry.customRedactionRules : [];
      const promptRedacted = mode === "full" ? prompt : mode === "redacted" ? redactText(prompt, customRules) : null;
      const responseRedacted = mode === "full" ? response : mode === "redacted" ? redactText(response, customRules) : null;
      getDatabase().prepare(`
        INSERT INTO ai_request_log (
          id, workspaceId, routeId, agentRole, userId,
          promptHash, promptRedacted, responseRedacted,
          inputTokens, outputTokens, costUsd, latencyMs,
          outcome, errorReason, traceId, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id || `air-${crypto.randomUUID()}`,
        entry.workspaceId,
        entry.routeId || null,
        entry.agentRole || null,
        entry.userId || null,
        hashPrompt(prompt),
        promptRedacted,
        responseRedacted,
        Number.isFinite(entry.inputTokens) ? entry.inputTokens : null,
        Number.isFinite(entry.outputTokens) ? entry.outputTokens : null,
        Number.isFinite(entry.costUsd) ? entry.costUsd : null,
        Number.isFinite(entry.latencyMs) ? entry.latencyMs : null,
        entry.outcome || "success",
        entry.errorReason || null,
        entry.traceId || null,
        new Date().toISOString(),
      );
    } catch {}
  });
}
