/**
 * @module tests/vision-heal-reaction
 * @description MNT-001 — unit tests for `performVisionHealReaction`,
 * the coordinate re-action helper invoked from `executeTest.js` after a
 * successful vision heal.
 *
 * Stub-driven: we inject a fake `{ mouse, keyboard }` shape like
 * Playwright's Page so the helper can be exercised without a real
 * browser. The contract under test is the verb→method mapping, the
 * bbox→center-coordinate math, the value-aware fill sequence
 * (click → select-all → type), best-effort error swallowing, and the
 * documented limitations around select/check/uncheck/focus.
 */
import assert from "node:assert/strict";
import { performVisionHealReaction } from "../src/runner/executeTest.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

/**
 * Build a fake page object that records every mouse call. The test then
 * asserts on `calls` to verify verb routing + coordinates without needing
 * a real browser.
 */
function fakePage({ throwOn } = {}) {
  const calls = [];
  const recorder = (method) => async (...args) => {
    calls.push({ method, args });
    if (throwOn === method) throw new Error(`${method} failed`);
  };
  return {
    calls,
    mouse: {
      click: recorder("click"),
      dblclick: recorder("dblclick"),
      move: recorder("move"),
    },
    // MNT-001 — keyboard surface for the value-aware fill branch
    // (mouse.click → keyboard.press("Control+a") → keyboard.type(value)).
    keyboard: {
      press: recorder("press"),
      type: recorder("type"),
    },
  };
}

/** Build a fakePage without a `keyboard` surface to exercise the
 *  "page lacks keyboard → skip fill branch" guard. */
function fakePageNoKeyboard() {
  const calls = [];
  const recorder = (method) => async (...args) => { calls.push({ method, args }); };
  return {
    calls,
    mouse: { click: recorder("click"), dblclick: recorder("dblclick"), move: recorder("move") },
  };
}

const BOX = { x: 100, y: 200, width: 80, height: 32 };
// Center should round to (140, 216) — (100 + 40, 200 + 16).
const EXPECTED_CENTER = { x: 140, y: 216 };

console.log("\n── MNT-001b performVisionHealReaction ──");

await test("click verb dispatches page.mouse.click at bbox center", async () => {
  const page = fakePage();
  const r = await performVisionHealReaction(page, "click", BOX, "Submit", "click::Submit");
  assert.equal(r.dispatched, true);
  assert.equal(r.verb, "click");
  assert.equal(r.x, EXPECTED_CENTER.x);
  assert.equal(r.y, EXPECTED_CENTER.y);
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].method, "click");
  assert.deepEqual(page.calls[0].args, [EXPECTED_CENTER.x, EXPECTED_CENTER.y]);
});

await test("press verb routes to mouse.click (same effect as click)", async () => {
  const page = fakePage();
  const r = await performVisionHealReaction(page, "press", BOX, "x", "press::x");
  assert.equal(r.dispatched, true);
  assert.equal(page.calls[0].method, "click");
});

await test("tap verb routes to mouse.click (touch viewport coverage)", async () => {
  const page = fakePage();
  const r = await performVisionHealReaction(page, "tap", BOX, "x", "tap::x");
  assert.equal(r.dispatched, true);
  assert.equal(page.calls[0].method, "click");
});

await test("dblclick verb dispatches page.mouse.dblclick", async () => {
  const page = fakePage();
  const r = await performVisionHealReaction(page, "dblclick", BOX, "x", "dblclick::x");
  assert.equal(r.dispatched, true);
  assert.equal(page.calls[0].method, "dblclick");
});

await test("hover verb dispatches page.mouse.move", async () => {
  const page = fakePage();
  const r = await performVisionHealReaction(page, "hover", BOX, "x", "hover::x");
  assert.equal(r.dispatched, true);
  assert.equal(page.calls[0].method, "move");
});

await test("rightclick verb dispatches click with button:right", async () => {
  const page = fakePage();
  const r = await performVisionHealReaction(page, "rightclick", BOX, "x", "rightclick::x");
  assert.equal(r.dispatched, true);
  assert.equal(page.calls[0].method, "click");
  // Third arg must carry `{ button: "right" }` so the test pins this
  // contract — a regression that drops it would silently turn every
  // rightclick re-action into a left-click.
  assert.deepEqual(page.calls[0].args[2], { button: "right" });
});

await test("verb casing is normalised (CLICK, Click, click all dispatch)", async () => {
  for (const verb of ["CLICK", "Click", "cLiCk"]) {
    const page = fakePage();
    const r = await performVisionHealReaction(page, verb, BOX, "x", `${verb}::x`);
    assert.equal(r.dispatched, true, `verb=${verb} should dispatch`);
    assert.equal(page.calls.length, 1, `verb=${verb} should call mouse.click once`);
  }
});

await test("fill verb with value-intent dispatches click → Control+a → type", async () => {
  // MNT-001 — value-aware fill re-action. The audit row must record
  // dispatched=true AND the three-step keyboard sequence must fire in
  // order: focus click, select-all, type.
  const page = fakePage();
  const r = await performVisionHealReaction(
    page, "fill", BOX, "Email", "fill::Email", { value: "user@example.com" },
  );
  assert.equal(r.dispatched, true);
  assert.equal(r.verb, "fill");
  assert.equal(page.calls.length, 3, "expected click + press + type");
  assert.equal(page.calls[0].method, "click");
  assert.deepEqual(page.calls[0].args, [EXPECTED_CENTER.x, EXPECTED_CENTER.y]);
  assert.equal(page.calls[1].method, "press");
  assert.equal(page.calls[1].args[0], "Control+a");
  assert.equal(page.calls[2].method, "type");
  assert.equal(page.calls[2].args[0], "user@example.com");
});

await test("fill verb WITHOUT value-intent skips dispatch (audit-only)", async () => {
  // Defensive guard — missing intent must NOT land an empty-string fill
  // (which would corrupt validation tests that fail because the field is
  // blank, not because the test couldn't write to it).
  const page = fakePage();
  const r = await performVisionHealReaction(page, "fill", BOX, "Email", "fill::Email");
  assert.equal(r.dispatched, false, "fill without intent must not dispatch");
  assert.equal(page.calls.length, 0, "no mouse / keyboard calls without intent");
  // Coordinates still computed for the audit row.
  assert.equal(r.x, EXPECTED_CENTER.x);
  assert.equal(r.y, EXPECTED_CENTER.y);
});

await test("fill verb skips dispatch when intent.value is not a string", async () => {
  // Type-strict guard — number / null / object intents must not crash
  // keyboard.type() inside Playwright.
  for (const badIntent of [{ value: 42 }, { value: null }, { value: undefined }, { value: { x: 1 } }, {}]) {
    const page = fakePage();
    const r = await performVisionHealReaction(page, "fill", BOX, "Age", "fill::Age", badIntent);
    assert.equal(r.dispatched, false, `intent=${JSON.stringify(badIntent)} should not dispatch`);
    assert.equal(page.calls.length, 0);
  }
});

await test("fill verb on page without .keyboard skips dispatch", async () => {
  // Defensive guard — if the test fake (or a future Playwright version
  // change) omits keyboard, we must NOT half-dispatch (click only) and
  // mark dispatched=true. Either the full sequence runs or none of it.
  const page = fakePageNoKeyboard();
  const r = await performVisionHealReaction(
    page, "fill", BOX, "Email", "fill::Email", { value: "user@example.com" },
  );
  assert.equal(r.dispatched, false);
  assert.equal(page.calls.length, 0);
});

await test("select / check / uncheck / focus fall through with audit metadata", async () => {
  // Documented limitations (NOT a deferred-ticket gap) — see the JSDoc
  // on performVisionHealReaction for the concrete justification per verb.
  // These tests pin the contract that the audit row still records the
  // bbox center even though no DOM action fires.
  for (const verb of ["select", "check", "uncheck", "focus"]) {
    const page = fakePage();
    const r = await performVisionHealReaction(page, verb, BOX, "x", `${verb}::x`,
      verb === "select" ? { value: "US" } : undefined);
    assert.equal(r.dispatched, false, `verb=${verb} is a documented limitation`);
    assert.equal(page.calls.length, 0, `verb=${verb} must not touch page.mouse or page.keyboard`);
    assert.equal(r.x, EXPECTED_CENTER.x);
    assert.equal(r.y, EXPECTED_CENTER.y);
  }
});

await test("missing / non-finite box returns dispatched=false (no mouse call)", async () => {
  const page = fakePage();
  for (const badBox of [null, undefined, {}, { x: 1, y: 2 }, { x: NaN, y: 0, width: 1, height: 1 }]) {
    const r = await performVisionHealReaction(page, "click", badBox, "x", "click::x");
    assert.equal(r.dispatched, false);
  }
  assert.equal(page.calls.length, 0, "no mouse calls on invalid box");
});

await test("page without .mouse returns dispatched=false (no throw)", async () => {
  const r = await performVisionHealReaction({}, "click", BOX, "x", "click::x");
  assert.equal(r.dispatched, false);
});

await test("page=null returns dispatched=false (no throw)", async () => {
  const r = await performVisionHealReaction(null, "click", BOX, "x", "click::x");
  assert.equal(r.dispatched, false);
});

await test("mouse.click throwing is swallowed — never propagates to caller", async () => {
  // `.catch(() => {})` inside the helper already absorbs the typical
  // async error. This pins the contract: the helper must never throw
  // because callers don't expect to wrap it in try/catch (the test
  // body has ALREADY failed by the time we re-action).
  const page = fakePage({ throwOn: "click" });
  let threw = false;
  let r;
  try {
    r = await performVisionHealReaction(page, "click", BOX, "x", "click::x");
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "performVisionHealReaction must never throw");
  // dispatched: true because the call was attempted before the .catch
  // chain ran — the audit row should still record we tried.
  assert.equal(r.dispatched, true);
});

await test("bbox center math handles odd dimensions via Math.round", async () => {
  // 81 wide, 33 tall — center is (100 + 40.5, 200 + 16.5) → rounds to (141, 217).
  const oddBox = { x: 100, y: 200, width: 81, height: 33 };
  const page = fakePage();
  const r = await performVisionHealReaction(page, "click", oddBox, "x", "click::x");
  assert.equal(r.x, 141);
  assert.equal(r.y, 217);
  assert.deepEqual(page.calls[0].args, [141, 217]);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
