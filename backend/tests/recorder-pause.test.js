import assert from "node:assert/strict";
import {
  pauseRecording,
  resumeRecording,
  popLastRecordingAction,
  forwardInput,
  getRecording,
  switchDevice,
  probeAtPoint,
  _testSeedSession,
} from "../src/runner/recorder.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function makeFakeCdp() {
  const calls = [];
  return {
    calls,
    async send(method, args) { calls.push({ method, args }); },
  };
}

console.log("\nrecorder-pause — pauseRecording / resumeRecording / popLastRecordingAction");

test("pauseRecording flips session.paused = true and resumeRecording flips it back", () => {
  const dispose = _testSeedSession("REC-pause-toggle");
  try {
    const sess = getRecording("REC-pause-toggle");
    assert.ok(sess, "seeded session must be discoverable");
    assert.notEqual(sess.paused, true);
    assert.deepEqual(pauseRecording("REC-pause-toggle"), { paused: true });
    assert.equal(sess.paused, true);
    assert.deepEqual(resumeRecording("REC-pause-toggle"), { paused: false });
    assert.equal(sess.paused, false);
  } finally { dispose(); }
});

test("pauseRecording is idempotent — calling twice keeps paused = true", () => {
  const dispose = _testSeedSession("REC-pause-idemp");
  try {
    pauseRecording("REC-pause-idemp");
    pauseRecording("REC-pause-idemp");
    assert.equal(getRecording("REC-pause-idemp").paused, true);
  } finally { dispose(); }
});

test("resumeRecording is idempotent on a session that was never paused", () => {
  const dispose = _testSeedSession("REC-resume-idemp");
  try {
    assert.deepEqual(resumeRecording("REC-resume-idemp"), { paused: false });
    assert.equal(getRecording("REC-resume-idemp").paused, false);
  } finally { dispose(); }
});

test("pauseRecording / resumeRecording / popLast throw when the session is unknown", () => {
  assert.throws(() => pauseRecording("REC-nope"), /not found/i);
  assert.throws(() => resumeRecording("REC-nope"), /not found/i);
  assert.throws(() => popLastRecordingAction("REC-nope"), /not found/i);
});

test("pauseRecording / resumeRecording / popLast throw when the session is mid-teardown", () => {
  // The route handler maps `not found|not recording` to 404 — the helper's
  // own error message must surface "is not recording" so the regex match
  // in the route catch keeps working.
  const dispose = _testSeedSession("REC-stop", { status: "stopping" });
  try {
    assert.throws(() => pauseRecording("REC-stop"), /not recording/i);
    assert.throws(() => resumeRecording("REC-stop"), /not recording/i);
    assert.throws(() => popLastRecordingAction("REC-stop"), /not recording/i);
  } finally { dispose(); }
});

test("popLastRecordingAction removes the last captured action and reports the new count", () => {
  const dispose = _testSeedSession("REC-pop-basic");
  try {
    const sess = getRecording("REC-pop-basic");
    sess.actions.push({ kind: "goto", url: "https://x", ts: 1 });
    sess.actions.push({ kind: "click", selector: "#ok", ts: 2 });
    const result = popLastRecordingAction("REC-pop-basic");
    assert.equal(result.actionCount, 1);
    assert.deepEqual(result.removed, { kind: "click", selector: "#ok", ts: 2 });
    assert.equal(sess.actions.length, 1);
    assert.equal(sess.actions[0].kind, "goto");
  } finally { dispose(); }
});

test("popLastRecordingAction is idempotent on empty actions[] (returns null, never throws)", () => {
  // NEXT.md acceptance criterion: pop-last must be idempotent on an empty
  // actions[] — the UI fires it without checking step count first.
  const dispose = _testSeedSession("REC-pop-empty");
  try {
    assert.deepEqual(popLastRecordingAction("REC-pop-empty"), { removed: null, actionCount: 0 });
    assert.deepEqual(popLastRecordingAction("REC-pop-empty"), { removed: null, actionCount: 0 });
  } finally { dispose(); }
});

console.log("\nrecorder-pause — forwardInput honours session.paused");

await asyncTest("forwardInput short-circuits CDP dispatch while paused", async () => {
  const cdp = makeFakeCdp();
  const dispose = _testSeedSession("REC-pause-fwd", { cdpSession: cdp });
  try {
    pauseRecording("REC-pause-fwd");
    await forwardInput("REC-pause-fwd", { type: "mousePressed", x: 1, y: 1, button: 0 });
    await forwardInput("REC-pause-fwd", { type: "keyDown", key: "Enter", code: "Enter" });
    await forwardInput("REC-pause-fwd", { type: "scroll", x: 0, y: 0, deltaY: 10 });
    assert.equal(cdp.calls.length, 0, "no CDP calls should be made while paused");

    resumeRecording("REC-pause-fwd");
    await forwardInput("REC-pause-fwd", { type: "mousePressed", x: 1, y: 1, button: 0 });
    assert.equal(cdp.calls.length, 1, "CDP dispatch must resume after resumeRecording()");
    assert.equal(cdp.calls[0].method, "Input.dispatchMouseEvent");
  } finally { dispose(); }
});

console.log("\nrecorder-pause — in-page paused guards (source-level contract)");

await asyncTest("__sentriRecord exposeBinding callback short-circuits when session.paused === true", async () => {
  // The binding callback fires inside the headless browser context, so we
  // can't execute it from a unit test. Lock the guard down at source level
  // the same way recorder.test.js locks down the keydown editable-field
  // guard — assert the exact `session.paused === true` early-return lives
  // inside the exposeBinding(__sentriRecord, ...) block.
  const fs = await import("node:fs");
  const urlMod = await import("node:url");
  const here = urlMod.fileURLToPath(new URL(".", import.meta.url));
  const src = fs.readFileSync(`${here}../src/runner/recorder.js`, "utf8");

  const bindingIdx = src.indexOf('context.exposeBinding("__sentriRecord"');
  assert.ok(bindingIdx >= 0, "exposeBinding(__sentriRecord, …) must exist");
  // Bounded window so a future occurrence elsewhere in the file can't
  // make this assertion pass spuriously.
  const slice = src.slice(bindingIdx, bindingIdx + 2000);
  assert.match(
    slice,
    /if\s*\(\s*session\.paused\s*===\s*true\s*\)\s*return\s*;/,
    "__sentriRecord callback must short-circuit while paused",
  );
});

await asyncTest("popup + debounced framenavigated handlers both skip captures while paused", async () => {
  // Both `framenavigated` listeners — the popup handler inside
  // context.on("page", ...) and the debounced main-page timer — can
  // synthesise `goto` actions after pause if a navigation started before
  // pause but settled after. Both must drop captures while paused. We
  // assert this at source level (no real browser available here).
  const fs = await import("node:fs");
  const urlMod = await import("node:url");
  const here = urlMod.fileURLToPath(new URL(".", import.meta.url));
  const src = fs.readFileSync(`${here}../src/runner/recorder.js`, "utf8");

  // Both handlers must contain the early-return. We count occurrences of
  // the exact predicate inside the file rather than locating the precise
  // handler — three call sites (exposeBinding + 2 × framenavigated) plus
  // forwardInput = at least four total occurrences across the module.
  const matches = src.match(/if\s*\(\s*session\.paused\s*===\s*true\s*\)\s*return\s*;/g) || [];
  assert.ok(
    matches.length >= 4,
    `expected ≥4 session.paused guards (forwardInput + __sentriRecord + 2 × framenavigated), got ${matches.length}`,
  );
});

console.log("\nrecorder-pause — switchDevice (DIF-015c Gap 5)");

await asyncTest("switchDevice throws when session is unknown", async () => {
  await assert.rejects(switchDevice("REC-nope", "iPhone 14"), /not found/i);
});

await asyncTest("switchDevice throws when session is mid-teardown", async () => {
  const dispose = _testSeedSession("REC-dev-stop", { status: "stopping" });
  try {
    await assert.rejects(switchDevice("REC-dev-stop", "iPhone 14"), /not recording/i);
  } finally { dispose(); }
});

await asyncTest("switchDevice rejects an unknown device name", async () => {
  // The allowlist is built from DEVICE_PRESETS at module load. Any
  // device outside that curated list must be a 400 from the caller's
  // perspective; the helper surfaces it as a thrown Error which the
  // route layer maps to 400 via the regex `/Invalid device/i` check.
  const dispose = _testSeedSession("REC-dev-bogus");
  try {
    await assert.rejects(switchDevice("REC-dev-bogus", "NokiaN95"), /Invalid device/i);
  } finally { dispose(); }
});

await asyncTest("switchDevice is idempotent on the active device (returns current viewport, no teardown)", async () => {
  // Seed a session that's already on iPhone 14. Asking to switch to the
  // same device must NOT touch session.browser / context / page — those
  // are null in the seed and a teardown attempt would crash. The helper
  // detects the equal-device case BEFORE the teardown code path runs.
  const dispose = _testSeedSession("REC-dev-idemp", {
    device: "iPhone 14",
    viewport: { width: 390, height: 844 },
    url: "https://example.com",
  });
  try {
    const result = await switchDevice("REC-dev-idemp", "iPhone 14");
    assert.equal(result.device, "iPhone 14");
    assert.deepEqual(result.viewport, { width: 390, height: 844 });
    assert.equal(result.url, "https://example.com");
  } finally { dispose(); }
});

await asyncTest("switchDevice throws when session has no browser (defensive)", async () => {
  // Defensive guard for the case where a session was seeded without a
  // browser (e.g. a test-only path that bypassed startRecording). The
  // helper surfaces this clearly rather than crashing on
  // `session.browser.newContext` with a TypeError.
  const dispose = _testSeedSession("REC-dev-nobrowser", {
    device: "",
    viewport: { width: 1280, height: 720 },
  });
  try {
    await assert.rejects(
      switchDevice("REC-dev-nobrowser", "iPhone 14"),
      /no browser to switch device on/i,
    );
  } finally { dispose(); }
});

console.log("\nrecorder-pause — switchDevice source-level guards");

await asyncTest("switchDevice preserves session.actions[] across the rebuild path (contract assertion)", async () => {
  // We can't exercise the full rebuild without a real Chromium, but the
  // critical contract is that `session.actions` is NEVER reassigned —
  // the teardown only nulls `context/page/cdpSession/stopScreencast`.
  // Lock that down at source level the same way the in-page paused
  // guards are locked down: assert the file source does NOT contain
  // `session.actions =` (an assignment that would clear the array).
  const fs = await import("node:fs");
  const urlMod = await import("node:url");
  const here = urlMod.fileURLToPath(new URL(".", import.meta.url));
  const src = fs.readFileSync(`${here}../src/runner/recorder.js`, "utf8");

  // A bare `session.actions =` (assignment) inside switchDevice would
  // wipe captured steps. The only legitimate writes are .push / .pop /
  // .splice. Locate switchDevice and scan its body for the forbidden
  // pattern.
  const idx = src.indexOf("export async function switchDevice(");
  assert.ok(idx >= 0, "switchDevice must exist");
  // Bounded window — `switchDevice` is ~80 lines, helper ~100 lines,
  // 5000 chars is safely larger than both.
  const slice = src.slice(idx, idx + 5000);
  assert.doesNotMatch(
    slice,
    /session\.actions\s*=\s*[^=]/,
    "switchDevice must NEVER reassign session.actions (would wipe captured steps)",
  );
});

console.log("\nrecorder-pause — probeAtPoint (DIF-015c Gap 2 hover-pick)");

await asyncTest("probeAtPoint throws when session is unknown", async () => {
  await assert.rejects(probeAtPoint("REC-nope", { x: 10, y: 20 }), /not found/i);
});

await asyncTest("probeAtPoint throws when session is mid-teardown", async () => {
  const dispose = _testSeedSession("REC-probe-stop", { status: "stopping" });
  try {
    await assert.rejects(probeAtPoint("REC-probe-stop", { x: 10, y: 20 }), /not recording/i);
  } finally { dispose(); }
});

await asyncTest("probeAtPoint throws when session has no active page", async () => {
  // Default seed leaves session.page undefined — the helper must surface
  // a clear error rather than crashing on `session.page.evaluate`.
  const dispose = _testSeedSession("REC-probe-nopage");
  try {
    await assert.rejects(probeAtPoint("REC-probe-nopage", { x: 1, y: 1 }), /no active page/i);
  } finally { dispose(); }
});

await asyncTest("probeAtPoint forwards rounded integer coordinates to page.evaluate", async () => {
  // Defensive contract: the helper rounds + clamps coordinates to ≥ 0
  // integers before calling page.evaluate, so a malformed payload (NaN,
  // negative, fractional CSS pixel) never reaches CDP. Use a fake page
  // that records its evaluate args.
  const evalCalls = [];
  const fakePage = {
    evaluate: async (_fn, arg) => {
      evalCalls.push(arg);
      return { selector: "#x", label: "x", rect: { x: 0, y: 0, width: 1, height: 1 } };
    },
  };
  const dispose = _testSeedSession("REC-probe-args", { page: fakePage });
  try {
    await probeAtPoint("REC-probe-args", { x: 12.7, y: -5 });
    assert.equal(evalCalls.length, 1);
    assert.equal(evalCalls[0].x, 13, "x must be rounded");
    assert.equal(evalCalls[0].y, 0, "y must be clamped to 0 when negative");
    // NaN / non-numeric falls back to 0, never NaN reaching CDP.
    await probeAtPoint("REC-probe-args", { x: "garbage", y: undefined });
    assert.equal(evalCalls[1].x, 0);
    assert.equal(evalCalls[1].y, 0);
  } finally { dispose(); }
});

await asyncTest("probeAtPoint returns null when the in-page helper is missing", async () => {
  // Simulates the case where the recorder script hasn't installed
  // `__sentriProbeAtPoint` yet (page mid-load, init script failed).
  // The page-side IIFE returns null in that branch, and the Node-side
  // helper passes that through verbatim so the frontend can drop the
  // highlight overlay rather than show a stale outline.
  const fakePage = {
    evaluate: async () => null,
  };
  const dispose = _testSeedSession("REC-probe-nohelper", { page: fakePage });
  try {
    const result = await probeAtPoint("REC-probe-nohelper", { x: 10, y: 20 });
    assert.equal(result, null);
  } finally { dispose(); }
});

await asyncTest("probeAtPoint returns the in-page helper's payload verbatim", async () => {
  const expected = {
    selector: 'role=button[name="Sign in"]',
    label: "Sign in",
    rect: { x: 100, y: 200, width: 80, height: 32 },
  };
  const fakePage = { evaluate: async () => expected };
  const dispose = _testSeedSession("REC-probe-ok", { page: fakePage });
  try {
    const result = await probeAtPoint("REC-probe-ok", { x: 140, y: 216 });
    assert.deepEqual(result, expected);
  } finally { dispose(); }
});

await asyncTest("probeAtPoint returns null on transient page navigation errors (best-effort)", async () => {
  // Page navigating mid-probe → page.evaluate rejects. The helper
  // swallows and returns null so the frontend just drops the highlight
  // rather than surfacing a 500 to the operator. Mirrors the same
  // "ignore transient CDP errors" pattern in `forwardInput`.
  const fakePage = {
    evaluate: async () => { throw new Error("Target closed"); },
  };
  const dispose = _testSeedSession("REC-probe-err", { page: fakePage });
  try {
    const result = await probeAtPoint("REC-probe-err", { x: 5, y: 5 });
    assert.equal(result, null);
  } finally { dispose(); }
});

console.log("\nrecorder-pause — STEALTH_SCRIPT (DIF-015c Gap 6 source-level contracts)");

await asyncTest("STEALTH_SCRIPT exists at module scope and patches the five expected surfaces", async () => {
  // Real Chromium isn't available in this harness, so we can't actually
  // launch a stealth context and probe `navigator.webdriver`. The next
  // best contract is source-level: lock down that STEALTH_SCRIPT
  // exists, runs as an IIFE inside the page context, and patches
  // exactly the five fingerprint surfaces the JSDoc promises. Drift
  // here would silently break Gap 6 — a target site that detects via
  // one of the omitted surfaces would still block the recorder.
  const fs = await import("node:fs");
  const urlMod = await import("node:url");
  const here = urlMod.fileURLToPath(new URL(".", import.meta.url));
  const src = fs.readFileSync(`${here}../src/runner/recorder.js`, "utf8");

  // 1. The constant must exist as a top-level template literal so
  //    it's interpolation-free (no runtime injection of secrets).
  assert.match(src, /const STEALTH_SCRIPT = `/, "STEALTH_SCRIPT must be a top-level template-literal constant");

  // 2. Page-side guard against double-install (mirrors __sentriRecorder).
  assert.match(src, /window\.__sentriStealthInstalled/, "STEALTH_SCRIPT must guard against double-install");

  // 3. Each of the five patched surfaces — match the property name + the
  //    fact that we redefine it via defineProperty / replacement. If any
  //    of these stops matching, a target site that probes that surface
  //    will see the headless tell unpatched.
  assert.match(src, /Object\.defineProperty\(navigator, "webdriver"/, "must patch navigator.webdriver");
  assert.match(src, /Object\.defineProperty\(navigator, "plugins"/, "must patch navigator.plugins");
  assert.match(src, /Object\.defineProperty\(navigator, "languages"/, "must patch navigator.languages");
  assert.match(src, /window\.chrome[^a-z]/, "must reference window.chrome (the runtime stub)");
  assert.match(src, /window\.Permissions\.prototype\.query/, "must patch Permissions.prototype.query");

  // 4. Default-mode safety: STEALTH_SCRIPT must NOT appear in any code
  //    path that runs unconditionally. Both addInitScript(STEALTH_SCRIPT)
  //    sites are gated by `if (session.stealth === true)` /
  //    `if (stealth === true)` — assert both gates are present so a
  //    refactor that drops the guard can't silently apply stealth to
  //    every recording session.
  const addInitCalls = src.match(/await context\.addInitScript\(STEALTH_SCRIPT\)/g) || [];
  assert.ok(addInitCalls.length >= 2, "STEALTH_SCRIPT must be installed in both startRecording AND _finishOpenRecorderPage");
  // Both call sites must sit inside `stealth === true` predicates.
  const guardedCalls = src.match(/if\s*\(\s*(?:session\.)?stealth\s*===\s*true\s*\)\s*\{\s*\n\s*await context\.addInitScript\(STEALTH_SCRIPT\)/g) || [];
  assert.equal(
    guardedCalls.length, 2,
    "both STEALTH_SCRIPT addInitScript calls must be guarded by `stealth === true` — default-mode runs would otherwise install stealth unconditionally",
  );
});

await asyncTest("STEALTH_SCRIPT registers BEFORE bootstrap + RECORDER_SCRIPT (ordering contract)", async () => {
  // The init-script order matters: stealth must run first so that
  // by the time RECORDER_SCRIPT's selectorGenerator (and any SUT
  // bootstrap script) reads `navigator.webdriver`, the patched
  // `undefined` is what they see. If a future refactor reorders the
  // addInitScript calls, a target site that probes webdriver
  // synchronously during its own bootstrap could still detect us
  // even with stealth on.
  const fs = await import("node:fs");
  const urlMod = await import("node:url");
  const here = urlMod.fileURLToPath(new URL(".", import.meta.url));
  const src = fs.readFileSync(`${here}../src/runner/recorder.js`, "utf8");

  // Locate the startRecording stealth call and the matching
  // addInitScript(RECORDER_SCRIPT) below it. The stealth index must be
  // smaller (earlier in the function body) than the RECORDER_SCRIPT
  // index for the ordering to hold.
  const stealthIdx = src.indexOf("await context.addInitScript(STEALTH_SCRIPT)");
  assert.ok(stealthIdx >= 0, "STEALTH_SCRIPT addInitScript must exist");
  const recorderIdx = src.indexOf("await context.addInitScript(RECORDER_SCRIPT)", stealthIdx);
  assert.ok(recorderIdx > stealthIdx, "RECORDER_SCRIPT addInitScript must come AFTER STEALTH_SCRIPT in source order");
});

console.log("\nrecorder-pause — RECORDER_SCRIPT exposes __sentriProbeAtPoint (source-level contract)");

await asyncTest("RECORDER_SCRIPT installs window.__sentriProbeAtPoint with selector + label + rect", async () => {
  // The Node-side `probeAtPoint` calls `window.__sentriProbeAtPoint`
  // via page.evaluate; lock down at source level that the recorder
  // script DOES expose this helper, so a future RECORDER_SCRIPT refactor
  // can't silently strip it. Mirrors the source-inspection pattern used
  // for the `__sentriRecord` binding.
  const fs = await import("node:fs");
  const urlMod = await import("node:url");
  const here = urlMod.fileURLToPath(new URL(".", import.meta.url));
  const src = fs.readFileSync(`${here}../src/runner/recorder.js`, "utf8");
  assert.match(src, /window\.__sentriProbeAtPoint\s*=\s*\(\s*x\s*,\s*y\s*\)\s*=>/, "recorder script must install __sentriProbeAtPoint");
  // The probe must walk to the closest interactive ancestor (same set
  // the click/fill listeners use) so the picker's suggestion is byte-
  // aligned with what a real click would have captured.
  assert.match(src, /elementFromPoint\(x,\s*y\)/, "probe must use document.elementFromPoint");
  assert.match(src, /selectorGenerator\(target\)/, "probe must call the existing selectorGenerator");
  assert.match(src, /bestLabel\(target\)/, "probe must call the existing bestLabel");
});

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\nrecorder-pause tests failed");
  process.exit(1);
}

console.log("\nAll recorder-pause tests passed!");
