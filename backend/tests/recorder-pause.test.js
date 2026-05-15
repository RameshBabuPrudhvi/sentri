import assert from "node:assert/strict";
import {
  pauseRecording,
  resumeRecording,
  popLastRecordingAction,
  forwardInput,
  getRecording,
  switchDevice,
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

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\nrecorder-pause tests failed");
  process.exit(1);
}

console.log("\nAll recorder-pause tests passed!");
