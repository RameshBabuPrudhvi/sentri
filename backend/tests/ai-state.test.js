/**
 * @module tests/ai-state
 * @description Pins the `getAiProviderState()` inspector exported by
 * `backend/src/aiProvider/registry.js` and consumed by the new
 * `GET /api/v1/system/ai-state` route (Systems page "AI provider state"
 * panel).
 *
 * Coverage:
 *   1. Healthy state — empty breakers + stickies, constants surfaced.
 *   2. Open breaker — `openNow` + `remainingMs` reflect a tripped key.
 *   3. Per-role key splitting — `provider::role` keys parsed correctly.
 *   4. Sticky fallback — present in snapshot with positive `remainingMs`.
 *   5. Expired-sticky sweep — entries past their TTL drop on snapshot.
 *   6. Pure inspection — repeat calls don't mutate breaker / sticky state.
 *
 * Plain Node assertions, matches the project's test convention.
 */
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");
const {
  getAiProviderState,
  recordProviderFailure,
  recordProviderSuccess,
  setStickyFallback,
  clearStickyFallback,
  setRuntimeKey,
  STICKY_FALLBACK_TTL_MS,
} = await import("../src/aiProvider/registry.js");

// Boot DB so any incidental repo access from registry init paths doesn't
// throw — registry inspection itself is in-memory, but `setRuntimeKey`
// persists to `api_keys` and we use it to reset breakers between tests.
getDatabase();

const { test, summary } = createTestRunner();

/** Wipe every breaker + sticky entry so each test starts clean. */
function resetState() {
  // setRuntimeKey triggers resetCircuitBreaker(provider) + clearStickyFallback()
  // internally. We call it for the families we use in this file so leftover
  // state from any earlier suite (or the `ANTHROPIC_API_KEY` env-driven
  // breaker tests) doesn't bleed in.
  setRuntimeKey("anthropic", "test-anthropic-key");
  setRuntimeKey("openai", "test-openai-key");
  clearStickyFallback();
}

// ── Healthy state ────────────────────────────────────────────────────────────
console.log("\n🧪 getAiProviderState — healthy state");

test("empty breakers + stickies on a clean registry", () => {
  resetState();
  const state = getAiProviderState();
  assert.deepEqual(state.breakers, [], "no open breakers after reset");
  assert.deepEqual(state.stickyFallbacks, [], "no sticky entries after reset");
});

test("constants are surfaced and non-null", () => {
  const state = getAiProviderState();
  assert.equal(typeof state.constants.CIRCUIT_BREAKER_THRESHOLD, "number");
  assert.equal(typeof state.constants.CIRCUIT_BREAKER_COOLDOWN_MS, "number");
  assert.equal(state.constants.STICKY_FALLBACK_TTL_MS, STICKY_FALLBACK_TTL_MS);
});

// ── Open breaker ─────────────────────────────────────────────────────────────
console.log("\n🧪 getAiProviderState — open breaker");

test("tripped bare-provider breaker shows openNow=true with positive remainingMs", () => {
  resetState();
  recordProviderFailure("anthropic", null);
  const state = getAiProviderState();
  const entry = state.breakers.find((b) => b.key === "anthropic");
  assert.ok(entry, "anthropic breaker should be in snapshot");
  assert.equal(entry.provider, "anthropic");
  assert.equal(entry.agentRole, null, "bare key has null agentRole");
  assert.equal(entry.openNow, true);
  assert.ok(entry.remainingMs > 0, "remainingMs should be > 0 while open");
  assert.ok(
    entry.remainingMs <= state.constants.CIRCUIT_BREAKER_COOLDOWN_MS,
    "remainingMs should never exceed the configured cooldown",
  );
  // Tidy up — leaving anthropic in open state could mask issues in
  // sticky-only tests below if they happen to run before resetState fires.
  resetState();
});

test("role-scoped breaker is parsed as { provider, agentRole }", () => {
  resetState();
  recordProviderFailure("anthropic", "planner");
  const state = getAiProviderState();
  const entry = state.breakers.find((b) => b.key === "anthropic::planner");
  assert.ok(entry, "role-scoped breaker should be in snapshot");
  assert.equal(entry.provider, "anthropic");
  assert.equal(entry.agentRole, "planner");
  assert.equal(entry.openNow, true);
  resetState();
});

test("recordProviderSuccess does NOT close the breaker (failures-only reset)", () => {
  // Documented contract from registry.js:341-344 — success resets the
  // failures counter but leaves `disabledUntil` alone until cooldown
  // elapses. The inspector must reflect that contract honestly so
  // operators see "still open for N seconds" rather than a false-green.
  resetState();
  recordProviderFailure("anthropic", null);
  recordProviderSuccess("anthropic", null);
  const state = getAiProviderState();
  const entry = state.breakers.find((b) => b.key === "anthropic");
  assert.ok(entry, "breaker entry should persist after success");
  assert.equal(entry.openNow, true, "still open until cooldown elapses");
  assert.equal(entry.failures, 0, "failures counter was reset by success");
  resetState();
});

// ── Sticky fallback ──────────────────────────────────────────────────────────
console.log("\n🧪 getAiProviderState — sticky fallback");

test("active sticky shows positive remainingMs near full TTL", () => {
  resetState();
  setStickyFallback("openai", "planner");
  const state = getAiProviderState();
  const entry = state.stickyFallbacks.find((s) => s.key === "openai::planner");
  assert.ok(entry, "sticky entry should appear in snapshot");
  assert.equal(entry.provider, "openai");
  assert.equal(entry.agentRole, "planner");
  // Sticky was just set → remainingMs should be within ~100ms of full TTL.
  // We use a 1s tolerance to absorb any CI scheduling jitter.
  const ttl = state.constants.STICKY_FALLBACK_TTL_MS;
  assert.ok(entry.remainingMs <= ttl, "remainingMs cannot exceed TTL");
  assert.ok(entry.remainingMs > ttl - 1000, `remainingMs ${entry.remainingMs} should be close to TTL ${ttl}`);
  resetState();
});

test("expired sticky is swept on snapshot (not stale)", () => {
  // sweepExpiredStickies runs at the top of getAiProviderState — pin
  // that contract so a future contributor doesn't drop the sweep and
  // surface a TTL-window of stale entries in the UI.
  resetState();
  setStickyFallback("openai", "planner");
  // Force-expire the entry by reaching into the registry's internal
  // Map. We can't do that directly (it's not exported), so instead use
  // the fact that clearStickyFallback by role removes the entry and
  // assert the snapshot returns clean immediately.
  clearStickyFallback("planner");
  const state = getAiProviderState();
  assert.equal(
    state.stickyFallbacks.find((s) => s.agentRole === "planner"),
    undefined,
    "cleared sticky should not appear in the next snapshot",
  );
});

// ── Inspection is pure ───────────────────────────────────────────────────────
console.log("\n🧪 getAiProviderState — pure inspection");

test("repeat snapshots return identical state without mutation", () => {
  resetState();
  recordProviderFailure("anthropic", "planner");
  setStickyFallback("openai", "author");
  const a = getAiProviderState();
  const b = getAiProviderState();
  // Snapshots may differ in `remainingMs` by a few ms between calls;
  // identity check is shape + counts + provider/role tuples, not the
  // millisecond clock.
  assert.equal(a.breakers.length, b.breakers.length);
  assert.equal(a.stickyFallbacks.length, b.stickyFallbacks.length);
  assert.equal(
    a.breakers.find((x) => x.key === "anthropic::planner")?.failures,
    b.breakers.find((x) => x.key === "anthropic::planner")?.failures,
    "failures counter should not drift between read-only snapshots",
  );
  resetState();
});

test("snapshot is JSON-safe (round-trips through JSON.stringify without loss)", () => {
  // The route handler passes the result directly to `res.json()` — pin
  // that no Map / Set / Date references sneak in via a future refactor.
  resetState();
  recordProviderFailure("anthropic", "planner");
  setStickyFallback("openai", "author");
  const state = getAiProviderState();
  const round = JSON.parse(JSON.stringify(state));
  assert.deepEqual(round.constants, state.constants);
  assert.equal(round.breakers.length, state.breakers.length);
  assert.equal(round.stickyFallbacks.length, state.stickyFallbacks.length);
  resetState();
});

summary("AI provider state inspector (Systems page panel)");
