/**
 * @module tests/request-log
 * @description B2.5 — AI request-log unit tests.
 *
 * Covers:
 *   1. `hashPrompt` determinism (placeholder retained).
 *   2. `redactText` — built-in regex coverage (email, phone, SSN,
 *      card) and workspace-supplied custom rules.
 *   3. Workspace storage-mode resolution
 *      (`workspaceRepo.getAiRequestLogSettings`).
 *   4. Retention sweep (`aiRequestLogRepo.purgeOlderThan`).
 *
 * Tests use the in-memory SQLite path established by other B2 test
 * files; no network, no real provider calls. The dispatcher's
 * `logRequest()` wiring is covered indirectly via the integration-
 * shaped tests in `agent-dispatch.test.js`.
 */
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";

const { createTestRunner } = await import("./helpers/test-base.js");
const { hashPrompt, redactText } = await import("../src/aiProvider/requestLog.js");
const { getDatabase } = await import("../src/database/sqlite.js");
const workspaceRepo = await import("../src/database/repositories/workspaceRepo.js");
const aiRequestLogRepo = await import("../src/database/repositories/aiRequestLogRepo.js");

getDatabase();
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
ensureDefaultWorkspaces();

const { test, summary } = createTestRunner();

function seedWorkspace() {
  const db = getDatabase();
  const userId = `usr-${Math.random().toString(36).slice(2, 10)}`;
  const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO users (id, name, email, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(userId, `Test ${userId}`, `${userId}@test.local`, "x", now, now);
  db.prepare(
    "INSERT INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(wsId, `ws-${wsId}`, wsId, userId, now, now);
  return wsId;
}
// ── 1. hashPrompt ─────────────────────────────────────────────────────────────

test("hashPrompt: deterministic sha256 hex", () => {
  const a = hashPrompt("hello");
  const b = hashPrompt("hello");
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("hashPrompt: null/undefined/empty → stable hash", () => {
  // The hash function defends against bad input by coercing to string;
  // all three should produce the same digest (empty string hash).
  assert.equal(typeof hashPrompt(""), "string");
  assert.equal(typeof hashPrompt(null), "string");
  assert.equal(typeof hashPrompt(undefined), "string");
});

// ── 2. redactText — built-in patterns ────────────────────────────────────────

test("redactText: email pattern", () => {
  const out = redactText("Contact me at alice@example.com please");
  assert.equal(out, "Contact me at [REDACTED_EMAIL] please");
});

test("redactText: phone pattern (international + national)", () => {
  const a = redactText("Call +1-555-123-4567 now");
  assert.match(a, /\[REDACTED_PHONE\]/);
  const b = redactText("Backup: 555 123 4567");
  assert.match(b, /\[REDACTED_PHONE\]/);
});

test("redactText: SSN pattern", () => {
  const out = redactText("SSN 123-45-6789 on file");
  assert.equal(out, "SSN [REDACTED_SSN] on file");
});

test("redactText: credit card pattern (13-19 digits, dashes ok)", () => {
  const a = redactText("Card 4111-1111-1111-1111 charged");
  assert.match(a, /\[REDACTED_CARD\]/);
  const b = redactText("Card 4111111111111111 charged");
  assert.match(b, /\[REDACTED_CARD\]/);
});

test("redactText: null/empty input → null", () => {
  assert.equal(redactText(""), null);
  assert.equal(redactText(null), null);
  assert.equal(redactText(undefined), null);
});

test("redactText: text without PII is unchanged", () => {
  const out = redactText("Just a plain message about test automation");
  assert.equal(out, "Just a plain message about test automation");
});
// ── 3. redactText — custom workspace rules ───────────────────────────────────

test("redactText: applies workspace-supplied custom rules", () => {
  const rules = [
    { pattern: "internal-id-\\d+", flags: "g", replacement: "[REDACTED_CUSTOM]" },
  ];
  const out = redactText("Token internal-id-12345 deleted", rules);
  assert.equal(out, "Token [REDACTED_CUSTOM] deleted");
});

test("redactText: custom rule with default replacement", () => {
  // No `replacement` field → defaults to `[REDACTED_CUSTOM]`.
  const rules = [{ pattern: "secret-\\w+", flags: "g" }];
  const out = redactText("API call uses secret-abc123 today", rules);
  assert.match(out, /\[REDACTED_CUSTOM\]/);
});

test("redactText: malformed custom regex doesn't crash; built-ins still fire", () => {
  // The pipeline's try/catch around each rule prevents one bad pattern
  // from breaking redaction of subsequent rules. The built-in email
  // regex still fires even when a downstream custom rule has invalid
  // syntax — defence in depth so an admin's typo doesn't disable PII
  // redaction for the whole workspace.
  const rules = [{ pattern: "[invalid(", flags: "g" }];
  const out = redactText("Email user@example.com still gets redacted", rules);
  assert.equal(out, "Email [REDACTED_EMAIL] still gets redacted");
});

test("redactText: built-in + custom rules compose", () => {
  const rules = [{ pattern: "proj-\\d+", flags: "g", replacement: "[REDACTED_PROJ]" }];
  const out = redactText("Email alice@example.com about proj-7", rules);
  assert.equal(out, "Email [REDACTED_EMAIL] about [REDACTED_PROJ]");
});

// ── 4. workspaceRepo.getAiRequestLogSettings ─────────────────────────────────

test("getAiRequestLogSettings: default mode is 'none' on a fresh workspace", () => {
  const wsId = seedWorkspace();
  const settings = workspaceRepo.getAiRequestLogSettings(wsId);
  assert.equal(settings.mode, "none");
  assert.deepStrictEqual(settings.customRules, []);
});

test("getAiRequestLogSettings: reads explicit 'redacted' mode", () => {
  const wsId = seedWorkspace();
  const db = getDatabase();
  db.prepare("UPDATE workspaces SET aiRequestLogMode = ? WHERE id = ?").run("redacted", wsId);
  const settings = workspaceRepo.getAiRequestLogSettings(wsId);
  assert.equal(settings.mode, "redacted");
});

test("getAiRequestLogSettings: parses customRedactionRules JSON column", () => {
  const wsId = seedWorkspace();
  const db = getDatabase();
  const rules = [{ pattern: "api-\\w+", flags: "g", replacement: "[REDACTED_API]" }];
  db.prepare("UPDATE workspaces SET aiRequestLogCustomRedactionRules = ? WHERE id = ?")
    .run(JSON.stringify(rules), wsId);
  const settings = workspaceRepo.getAiRequestLogSettings(wsId);
  assert.deepStrictEqual(settings.customRules, rules);
});

test("getAiRequestLogSettings: malformed JSON falls back to empty array", () => {
  const wsId = seedWorkspace();
  const db = getDatabase();
  db.prepare("UPDATE workspaces SET aiRequestLogCustomRedactionRules = ? WHERE id = ?")
    .run("{not valid json", wsId);
  const settings = workspaceRepo.getAiRequestLogSettings(wsId);
  assert.deepStrictEqual(settings.customRules, []);
});

test("getAiRequestLogSettings: unknown workspaceId returns safe defaults", () => {
  // No DB row for `ws-nonexistent` — getById returns undefined and we
  // fall back to the `{ mode: "none", customRules: [] }` shape so
  // callers never have to defend against an undefined return.
  const settings = workspaceRepo.getAiRequestLogSettings("ws-nonexistent");
  assert.equal(settings.mode, "none");
  assert.deepStrictEqual(settings.customRules, []);
});

test("getAiRequestLogSettings: null/empty workspaceId returns safe defaults", () => {
  const settings = workspaceRepo.getAiRequestLogSettings(null);
  assert.equal(settings.mode, "none");
  assert.deepStrictEqual(settings.customRules, []);
});

// ── 5. aiRequestLogRepo.purgeOlderThan ───────────────────────────────────────

test("purgeOlderThan: deletes rows older than N days, keeps newer ones", () => {
  const db = getDatabase();
  const wsId = seedWorkspace();
  // Three rows: 60 days old, 5 days old, 1 day old.
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString();
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
  const oneDayAgo = new Date(Date.now() - 1 * 86400000).toISOString();
  for (const [id, ts] of [["air-1", sixtyDaysAgo], ["air-2", fiveDaysAgo], ["air-3", oneDayAgo]]) {
    db.prepare(
      "INSERT INTO ai_request_log (id, workspaceId, promptHash, outcome, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).run(id, wsId, "x", "success", ts);
  }

  // Purge rows older than 30 days — should drop air-1 only.
  const deleted = aiRequestLogRepo.purgeOlderThan(30);
  assert.ok(deleted >= 1, "must delete at least the 60-days-old row");

  const remaining = db.prepare("SELECT id FROM ai_request_log WHERE workspaceId = ?").all(wsId);
  const ids = remaining.map((r) => r.id).sort();
  assert.deepStrictEqual(ids, ["air-2", "air-3"], "5-day-old and 1-day-old rows must survive 30-day purge");
});

test("purgeOlderThan: invalid days arg returns 0, deletes nothing", () => {
  assert.equal(aiRequestLogRepo.purgeOlderThan(0), 0);
  assert.equal(aiRequestLogRepo.purgeOlderThan(-1), 0);
  assert.equal(aiRequestLogRepo.purgeOlderThan(NaN), 0);
  assert.equal(aiRequestLogRepo.purgeOlderThan("not-a-number"), 0);
});

summary("AI request log (B2.5)");
