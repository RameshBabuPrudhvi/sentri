/**
 * @module tests/bundle-b-self-healing
 * @description Bundle-B fixes #7-#11 — self-healing reliability pins.
 */
import assert from "node:assert/strict";
import fs from "fs";

import {
  getSelfHealingHelperCode,
  getHealingHint,
  recordHealing,
  recordHealingFailure,
  STRATEGY_VERSION,
} from "../src/selfHealing.js";
// B1.2 (AUDIT-ROADMAP) — `healingRepo.set` is now routed through the
// write-batching queue per spec at `docs/roadmap/AUDIT-ROADMAP.md:176-179`.
// Tests that follow "write → read" must drain the queue between the two
// or the read sees stale state. `recordHealing` /`recordHealingFailure`
// and the direct `healingRepo.set` calls in this file all need this.
import { drain as drainDbWriteQueue } from "../src/utils/dbWriteQueue.js";

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✅  ${name}`))
    .catch((err) => {
      console.log(`  ❌  ${name}`);
      console.log(`      ${err.stack || err.message || err}`);
      process.exitCode = 1;
    });
}

console.log("\n🩹 Bundle-B self-healing pins (fixes #7–#11)");

const selfHealingSrc = fs.readFileSync(
  new URL("../src/selfHealing.js", import.meta.url),
  "utf8",
);

// ── Fix #7: stage-7 pixelmatch decline → recordHealingFailure ───────────────
await test("#7 stage-7 pixelmatch decline calls recordHealingFailure", () => {
  assert.match(selfHealingSrc, /recordHealingFailure\(ctx\.testId, ctx\.action, ctx\.label\)/);
  const testId = `bundle-b-fix7-${Date.now()}`;
  recordHealing(testId, "click", "Buy", 1);
  recordHealingFailure(testId, "click", "Buy");
  recordHealingFailure(testId, "click", "Buy");
  recordHealingFailure(testId, "click", "Buy");
  // B1.2 — `recordHealing` / `recordHealingFailure` route through the
  // queue; flush before `getHealingHint` reads the post-decay state.
  drainDbWriteQueue();
  assert.equal(getHealingHint(testId, "click", "Buy"), -1,
    "three stage-7 declines should demote the hint");
});

// ── Fix #8: version_mismatch metric ─────────────────────────────────────────
await test("#8 version_mismatch discards bump app_healing_hints_discarded_total", async () => {
  const { healingHintsDiscardedTotal } = await import("../src/utils/metrics.js");
  const healingRepo = await import("../src/database/repositories/healingRepo.js");
  const testId = `bundle-b-fix8-${Date.now()}`;
  recordHealing(testId, "click", "Submit", 0);
  // B1.2 — flush before reading the row back.
  drainDbWriteQueue();
  const key = `${testId}::click::Submit`;
  const row = healingRepo.get(key);
  healingRepo.set(key, { ...row, strategyVersion: STRATEGY_VERSION + 999 });
  // Flush the second set before `getHealingHint` consults it.
  drainDbWriteQueue();
  const valueOf = (m) => m.values.find((v) => v.labels.reason === "version_mismatch")?.value || 0;
  const before = valueOf(await healingHintsDiscardedTotal.get());
  const idx = getHealingHint(testId, "click", "Submit");
  const after = valueOf(await healingHintsDiscardedTotal.get());
  assert.equal(idx, -1);
  assert.equal(after, before + 1);
});

// ── Fix #9: buildPierceLocator renamed to buildCssLocator ───────────────────
await test("#9 runtime code uses buildCssLocator (not buildPierceLocator)", () => {
  const code = getSelfHealingHelperCode({});
  // Function definition must exist under the new name.
  assert.match(code, /function buildCssLocator\(page, selector\)/);
  // The OLD function name must not be DEFINED or CALLED anywhere. We
  // intentionally allow it to appear in code comments (the rename
  // rationale comment cites the old name) — pin only on syntactic
  // function/call positions, not raw substring.
  assert.doesNotMatch(code, /function buildPierceLocator\b/);
  assert.doesNotMatch(code, /\bbuildPierceLocator\s*\(/);
  // Backward-compat: "pierce:" prefix is still stripped for older selectors.
  assert.match(code, /selector\.startsWith\('pierce:'\)/);
});

// ── Fix #10: HEALING_HINT_DECAY_DAYS resets stale capped hints ──────────────
await test("#10 stale capped hint > decay window is re-eligible (failCount reset)", async () => {
  const healingRepo = await import("../src/database/repositories/healingRepo.js");
  const testId = `bundle-b-fix10-${Date.now()}`;
  const key = `${testId}::click::Pay`;
  const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
  healingRepo.set(key, {
    strategyIndex: 3,
    strategyVersion: STRATEGY_VERSION,
    succeededAt: new Date(eightDaysAgoMs).toISOString(),
    failCount: 3,
  });
  // B1.2 — flush the seeded row before `getHealingHint` runs the decay
  // reset path. `getHealingHint` itself also calls `healingRepo.set` (to
  // persist failCount=0), so drain again before the read-back.
  drainDbWriteQueue();
  const idx = getHealingHint(testId, "click", "Pay");
  drainDbWriteQueue();
  assert.equal(idx, 3, "stale hint should decay and become re-eligible");
  assert.equal(healingRepo.get(key).failCount, 0, "failCount should have been reset");
});

// ── Fix #11: __valueIntents keyed by step index ─────────────────────────────
await test("#11 safeFill writes both bare-key and step-suffixed value intent", () => {
  const code = getSelfHealingHelperCode({});
  assert.match(code, /__valueIntents\[healingKey\] = \{ value: strValue \}/);
  assert.match(code, /__valueIntents\[healingKey \+ '::step' \+ __step\]/);
  assert.match(code, /__valueIntentStepCounter/);
});

if (process.exitCode) process.exit(1);
console.log("\n🎉 Bundle-B self-healing pins passed");
