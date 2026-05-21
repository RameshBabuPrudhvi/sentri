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
//
// ## Pattern application order — DO NOT reorder
//
// Order is **rigid → loose**, not author-preference. The phone pattern
// (`PHONE_RE`) is intentionally permissive — `\+?\d[\d\s().-]{7,}\d`
// matches almost any 9+-digit run with separators. Run that first and
// it consumes the SSN (`123-45-6789` → 9 digits + dashes → matches
// `PHONE_RE`) and credit-card (`4111-1111-1111-1111` → 16 digits +
// dashes → matches `PHONE_RE`) inputs before the dedicated patterns
// can replace them with the correct sentinel. Reverse the order and
// every SSN ends up tagged `[REDACTED_PHONE]` and every card ends up
// tagged `[REDACTED_PHONE]` — same operator-visible field-name, but
// dashboards aggregating "calls that contained SSNs" silently report 0.
//
// Conserve the contract: rigid-format patterns first (SSN, then card),
// permissive patterns last (phone, then email). Email is last because
// it doesn't overlap any other pattern's character class — order-
// independent, but kept at the tail so the lifeguard rule above stays
// terse.
export function redactText(text, customRules = []) {
  if (!text) return null;
  let out = String(text);
  out = out.replace(SSN_RE, "[REDACTED_SSN]");
  out = out.replace(CARD_RE, "[REDACTED_CARD]");
  out = out.replace(PHONE_RE, "[REDACTED_PHONE]");
  out = out.replace(EMAIL_RE, "[REDACTED_EMAIL]");
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
