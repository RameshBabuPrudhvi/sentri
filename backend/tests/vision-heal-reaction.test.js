/**
 * @module tests/vision-heal-reaction
 * @description MNT-001b — unit tests for `performVisionHealReaction`,
 * the coordinate re-action helper invoked from `executeTest.js` after a
 * successful vision heal.
 *
 * Stub-driven: we inject a fake `{ mouse: { click, dblclick, move } }`
 * shaped like Playwright's Page so the helper can be exercised without
 * a real browser. The contract under test is the verb→method mapping
 * + bbox→center-coordinate math + best-effort error swallowing.
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

await test("fill / select / check fall through unmarked (MNT-001c territory)", async () => {
  for (const verb of ["fill", "select", "check", "uncheck", "focus"]) {
    const page = fakePage();
    const r = await performVisionHealReaction(page, verb, BOX, "x", `${verb}::x`);
    assert.equal(r.dispatched, false, `verb=${verb} should NOT dispatch (deferred)`);
    assert.equal(page.calls.length, 0, `verb=${verb} should not touch page.mouse`);
    // But coordinates still computed for the audit row.
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
