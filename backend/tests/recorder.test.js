/**
 * @module tests/recorder
 * @description Unit tests for the interactive browser recorder (DIF-015).
 *
 * Only `actionsToPlaywrightCode` is tested here — it is a pure string
 * transformation that does not require Playwright or a browser. The
 * `startRecording` / `stopRecording` pair depends on a real Chromium
 * launch and is covered implicitly by manual end-to-end testing.
 */

import assert from "node:assert/strict";
import { actionsToPlaywrightCode, forwardInput, recordedActionToStepText, _testSeedSession } from "../src/runner/recorder.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

/**
 * Tiny stand-in for a Playwright CDPSession. Records every `send(method, args)`
 * call so tests can assert on the exact CDP commands forwardInput dispatches.
 * @returns {{ send: Function, calls: Array<{method: string, args: Object}> }}
 */
function makeFakeCdp() {
  const calls = [];
  return {
    calls,
    async send(method, args) { calls.push({ method, args }); },
  };
}

console.log("\n🧪 recorder — actionsToPlaywrightCode");

test("does not duplicate the initial goto that startRecording pushes as actions[0]", () => {
  // startRecording always pushes `{ kind: "goto", url: startUrl }` as the
  // first action. actionsToPlaywrightCode already emits `page.goto(startUrl)`
  // at the top of the test body, so that first action must be suppressed to
  // avoid two back-to-back navigations to the same URL.
  const code = actionsToPlaywrightCode("Dedup", "https://example.com", [
    { kind: "goto", url: "https://example.com", ts: 1 },
    { kind: "click", selector: "#btn", ts: 2 },
  ]);
  const gotos = code.match(/await page\.goto\('https:\/\/example\.com'\);/g) || [];
  assert.equal(gotos.length, 1, "only one goto to startUrl should be emitted");
  assert.match(code, /await safeClick\(page, '#btn'\);/);
});

test("deduplicates consecutive gotos to the same URL", () => {
  const code = actionsToPlaywrightCode("Consecutive", "https://example.com", [
    { kind: "goto", url: "https://example.com", ts: 1 },
    { kind: "goto", url: "https://example.com/dashboard", ts: 2 },
    { kind: "goto", url: "https://example.com/dashboard", ts: 3 }, // framenavigated echo
    { kind: "click", selector: "#ok", ts: 4 },
  ]);
  const dashGotos = code.match(/page\.goto\('https:\/\/example\.com\/dashboard'\)/g) || [];
  assert.equal(dashGotos.length, 1, "consecutive gotos to the same URL collapse to one");
});

test("emits a runnable test skeleton even for zero actions", () => {
  const code = actionsToPlaywrightCode("Empty", "https://example.com", []);
  assert.match(code, /import \{ test, expect \} from '@playwright\/test';/);
  assert.match(code, /test\('Empty', async \(\{ page \}\) => \{/);
  assert.match(code, /await page\.goto\('https:\/\/example\.com'\);/);
  assert.match(code, /await expect\(page\)\.toHaveURL\(\/\.\*\/\);/);
});

test("translates a mixed action list into self-healing helpers and keyboard.press", () => {
  // All element interactions (click, fill, select, check, uncheck) must route
  // through their self-healing helper so recorded tests benefit from the
  // waterfall on first replay — `bestSelector()` produces CSS-looking output
  // that the `applyHealingTransforms` regex guard refuses to rewrite, so
  // `actionsToPlaywrightCode` is the last chance to pick the safe helper.
  const code = actionsToPlaywrightCode("Login flow", "https://example.com/login", [
    { kind: "click", selector: "#submit", ts: 1 },
    { kind: "fill", selector: "#email", value: "user@example.com", ts: 2 },
    { kind: "press", key: "Enter", ts: 3 },
    { kind: "select", selector: "#country", value: "US", ts: 4 },
    { kind: "check", selector: "#agree", ts: 5 },
    { kind: "uncheck", selector: "#agree", ts: 6 },
    { kind: "goto", url: "https://example.com/dashboard", ts: 7 },
  ]);
  assert.match(code, /await safeClick\(page, '#submit'\);/);
  assert.match(code, /await safeFill\(page, '#email', 'user@example\.com'\);/);
  assert.match(code, /await page\.keyboard\.press\('Enter'\);/);
  assert.match(code, /await safeSelect\(page, '#country', 'US'\);/);
  assert.match(code, /await safeCheck\(page, '#agree'\);/);
  assert.match(code, /await safeUncheck\(page, '#agree'\);/);
  assert.match(code, /await page\.goto\('https:\/\/example\.com\/dashboard'\);/);
  // Defence-in-depth: the raw Playwright calls must NOT appear anywhere in
  // the generated code — this catches accidental revert of the self-healing
  // dispatch in `actionsToPlaywrightCode`.
  assert.doesNotMatch(code, /\bawait\s+page\.selectOption\(/,
    "recorder must not emit raw page.selectOption() — use safeSelect");
  assert.doesNotMatch(code, /\bawait\s+page\.check\(/,
    "recorder must not emit raw page.check() — use safeCheck");
  assert.doesNotMatch(code, /\bawait\s+page\.uncheck\(/,
    "recorder must not emit raw page.uncheck() — use safeUncheck");
});

test("skips actions with missing selectors / keys / urls", () => {
  const code = actionsToPlaywrightCode("Sparse", "https://example.com", [
    { kind: "click", ts: 1 },        // no selector → skipped
    { kind: "press", ts: 2 },        // no key → skipped
    { kind: "goto", ts: 3 },         // no url → skipped
    { kind: "click", selector: "#ok", ts: 4 },
  ]);
  const clicks = code.match(/await safeClick/g) || [];
  assert.equal(clicks.length, 1, "only the well-formed click should be emitted");
  assert.doesNotMatch(code, /await page\.keyboard\.press\('/);
});

// ── Devin Review BUG_0002 regression — URL escaping ────────────────────────

test("escapes single quotes in the starting URL", () => {
  const code = actionsToPlaywrightCode(
    "Quote in start",
    "https://example.com/it's-a-page",
    [],
  );
  assert.match(code, /await page\.goto\('https:\/\/example\.com\/it\\'s-a-page'\);/);
});

test("escapes single quotes in per-step goto URLs", () => {
  const code = actionsToPlaywrightCode("Quote in step", "https://example.com", [
    { kind: "goto", url: "https://example.com/it's-a-page", ts: 1 },
  ]);
  assert.match(code, /await page\.goto\('https:\/\/example\.com\/it\\'s-a-page'\);/);
});

test("escapes single quotes in test name, selectors, and fill values", () => {
  const code = actionsToPlaywrightCode("It's a test", "https://example.com", [
    { kind: "click", selector: "button[aria-label='Close']", ts: 1 },
    { kind: "fill", selector: "#q", value: "I'm here", ts: 2 },
  ]);
  assert.match(code, /test\('It\\'s a test'/);
  assert.match(code, /await safeClick\(page, 'button\[aria-label=\\'Close\\']'\);/);
  assert.match(code, /await safeFill\(page, '#q', 'I\\'m here'\);/);
});

test("escapes newlines in fill values so multiline <textarea> input produces valid JS", () => {
  // A user typing into a <textarea> produces a `fill` action whose value
  // contains a literal U+000A. Interpolating that raw into a single-quoted
  // literal would split the string across source lines → SyntaxError at
  // runtime. The generated code must use `\\n` escapes.
  const code = actionsToPlaywrightCode("Multiline", "https://example.com", [
    { kind: "fill", selector: "#bio", value: "line1\nline2\nline3", ts: 1 },
  ]);
  // No raw newline inside the generated fill call.
  assert.doesNotMatch(code, /safeFill\(page, '#bio', 'line1\nline2/);
  // Properly escaped sequence.
  assert.match(code, /await safeFill\(page, '#bio', 'line1\\nline2\\nline3'\);/);
});

test("escapes backslashes so Windows paths and raw escape sequences replay verbatim", () => {
  // Raw `C:\new\file` would get re-interpreted: `\n` → newline, `\f` → form
  // feed. Backslashes must be doubled up first so the replayed value is
  // identical to what the user typed.
  const code = actionsToPlaywrightCode("Paths", "https://example.com", [
    { kind: "fill", selector: "#path", value: "C:\\new\\file", ts: 1 },
  ]);
  assert.match(code, /await safeFill\(page, '#path', 'C:\\\\new\\\\file'\);/);
});

test("escapes carriage returns and U+2028 / U+2029 line separators", () => {
  const code = actionsToPlaywrightCode("Sep", "https://example.com", [
    { kind: "fill", selector: "#x", value: "a\rb\u2028c\u2029d", ts: 1 },
  ]);
  assert.match(code, /await safeFill\(page, '#x', 'a\\rb\\u2028c\\u2029d'\);/);
});

test("escapes control characters (e.g. backspace U+0008) via \\xHH", () => {
  const code = actionsToPlaywrightCode("Ctrl", "https://example.com", [
    { kind: "fill", selector: "#x", value: "a\bb", ts: 1 },
  ]);
  assert.match(code, /await safeFill\(page, '#x', 'a\\x08b'\);/);
});

test("generated code is always syntactically parseable regardless of captured value content", () => {
  // Property-check style: throw every ugly string we can think of at the
  // generator and confirm the result parses as a module. If this ever
  // regresses the project's runner will refuse to execute the recorded
  // test at runtime.
  const nasties = [
    "simple",
    "it's complex",
    "line1\nline2",
    "C:\\Users\\root",
    "mix: '\\n' and \"quotes\" and \t\ttabs",
    "\u2028\u2029",
    "null\u0000byte",
  ];
  for (const s of nasties) {
    const code = actionsToPlaywrightCode(s, "https://example.com/" + s, [
      { kind: "fill", selector: "#f", value: s, ts: 1 },
      { kind: "select", selector: "#s", value: s, ts: 2 },
      { kind: "press", key: "Enter", ts: 3 },
    ]);
    // The generator wraps the body inside `test('…', async ({ page }) => { … })`
    // and prepends an `import` line. Strip both so we can parse just the body
    // as a Function and validate that every interpolated string literal is
    // syntactically valid.
    const bodyMatch = code.match(/async \(\{ page \}\) => \{\n([\s\S]*)\n\}\);\n$/);
    assert.ok(bodyMatch, `generated code should have the expected wrapper shape for input ${JSON.stringify(s)}`);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    assert.doesNotThrow(
      // All self-healing helper names must be in scope for the parsed body —
      // the generated code now references safeSelect / safeCheck / safeUncheck
      // in addition to safeClick / safeFill.
      () => new AsyncFunction("page", "expect", "safeClick", "safeFill", "safeSelect", "safeCheck", "safeUncheck", bodyMatch[1]),
      `generated body should parse for input ${JSON.stringify(s)}`,
    );
  }
});

// ── PR #115: recordedActionToStepText (human-readable Steps panel prose) ─
// These tests lock down the contract that the persisted `steps[]` array on a
// recorded test renders as English prose — matching how the AI generate /
// crawl pipeline (`outputSchema.js`) and the manual test creation path render
// steps. The Test Detail page renders all three sources through the same
// Steps panel, so any drift between them is immediately user-visible.

console.log("\n🧪 recorder — recordedActionToStepText");

test("goto: renders origin + pathname only, not full URL with query string", () => {
  // Recorder pages frequently navigate to query-heavy URLs (Amazon search,
  // OAuth redirects). Surfacing the raw URL in the Steps panel makes recorded
  // tests look noisier than AI-generated equivalents. Strip the query string
  // for display only — the playwrightCode still uses the full URL.
  const s = recordedActionToStepText({
    kind: "goto",
    url: "https://www.amazon.in/s?k=iphone+17+pro&crid=ABC&ref=tracking",
    ts: 1,
  });
  assert.equal(s, "User navigates to https://www.amazon.in/s");
});

test("goto: renders the full URL when there is no query string", () => {
  const s = recordedActionToStepText({ kind: "goto", url: "https://www.amazon.in/", ts: 1 });
  assert.equal(s, "User navigates to https://www.amazon.in/");
});

test("goto: falls back to the raw string (truncated) when URL parsing fails", () => {
  // Defensive — `framenavigated` can technically emit strings that are not
  // valid absolute URLs (e.g. relative paths, malformed strings during a
  // navigation race). The shortUrl() catch branch must not throw and must
  // not crash the step formatter.
  const s = recordedActionToStepText({ kind: "goto", url: "not-a-real-url", ts: 1 });
  assert.equal(s, "User navigates to not-a-real-url");
});

test("click: prefers the captured friendly label over the raw selector", () => {
  // The recorder now captures `label` alongside `selector` so the Steps
  // panel can read "User clicks the Sign in button" instead of leaking the
  // role= / CSS selector to reviewers.
  const s = recordedActionToStepText({
    kind: "click",
    selector: 'role=button[name="Sign in"]',
    label: "Sign in",
    ts: 1,
  });
  assert.equal(s, 'User clicks the "Sign in" button');
});

test("click: derives a friendly target from a role=foo[name=\"bar\"] selector when no label was captured", () => {
  // Older recordings made before the `label` field landed only carry the
  // selector. The formatter parses `role=…[name="…"]` so legacy steps don't
  // suddenly render as engineer-shaped strings after this upgrade ships.
  const s = recordedActionToStepText({
    kind: "click",
    selector: 'role=button[name="Save changes"]',
    ts: 1,
  });
  assert.equal(s, 'User clicks the "Save changes" button');
});

test("click: degrades cleanly to a target-less sentence when neither label nor role selector is present", () => {
  // A bare `#login` selector is engineer-shaped — leaking it into the Steps
  // panel was the original bug. Render a plain "User clicks" instead so the
  // step still reads as English even when we can't recover a label.
  const s = recordedActionToStepText({ kind: "click", selector: "#login", ts: 1 });
  assert.equal(s, "User clicks");
  assert.doesNotMatch(s, /#login/, "raw selector must not leak into the Steps panel");
});

test("fill: includes the captured value, truncated to avoid leaking long secrets", () => {
  // Recorded fill values can contain passwords / API keys. The full value
  // already lives in playwrightCode (where it's needed for replay), but the
  // human-readable steps must truncate aggressively so the Test Detail page
  // doesn't surface the full secret.
  const longPassword = "a".repeat(200);
  const s = recordedActionToStepText({
    kind: "fill",
    selector: "#password",
    label: "Password",
    value: longPassword,
    ts: 1,
  });
  assert.match(s, /^User fills the "Password" field with "/);
  // Value must be truncated to <=40 chars (per the helper's slice).
  const valueMatch = s.match(/with "([^"]*)"/);
  assert.ok(valueMatch, "step should expose a value segment");
  assert.ok(valueMatch[1].length <= 40, `value must be truncated, got ${valueMatch[1].length} chars`);
});

test("fill: handles missing value cleanly", () => {
  const s = recordedActionToStepText({
    kind: "fill",
    selector: "#email",
    label: "Email",
    ts: 1,
  });
  assert.equal(s, 'User fills the "Email" field with ""');
});

test("press: renders the key without leaking the selector", () => {
  // press is target-agnostic from the user's perspective — the panel should
  // read "User presses Enter" not "User presses Enter on #form".
  const s = recordedActionToStepText({ kind: "press", key: "Enter", selector: "#form", ts: 1 });
  assert.equal(s, "User presses Enter");
});

test("press: handles missing key by trimming the trailing space", () => {
  const s = recordedActionToStepText({ kind: "press", ts: 1 });
  assert.equal(s, "User presses");
});

test("select: renders selected value with friendly target dropdown noun", () => {
  const s = recordedActionToStepText({
    kind: "select",
    selector: "#country",
    label: "Country",
    value: "United Kingdom",
    ts: 1,
  });
  assert.equal(s, 'User selects "United Kingdom" in the "Country" dropdown');
});

test("select: omits the trailing 'in …' clause when no target can be derived", () => {
  // When neither label nor role-selector is available, the formatter renders
  // just the selected value rather than appending an empty " in" clause.
  const s = recordedActionToStepText({
    kind: "select",
    selector: ".some-class",
    value: "US",
    ts: 1,
  });
  assert.equal(s, 'User selects "US"');
  assert.doesNotMatch(s, /\bin\s*$/);
});

test("check / uncheck: render with the checkbox noun and friendly label", () => {
  const checked = recordedActionToStepText({
    kind: "check",
    selector: "#agree",
    label: "I agree",
    ts: 1,
  });
  const unchecked = recordedActionToStepText({
    kind: "uncheck",
    selector: "#agree",
    label: "I agree",
    ts: 2,
  });
  assert.equal(checked, 'User checks the "I agree" checkbox');
  assert.equal(unchecked, 'User unchecks the "I agree" checkbox');
});

test("default branch: renders the kind verbatim for unknown future action types", () => {
  // Forward-compat: if the recorder script gains a new action kind without
  // the formatter being updated, we still emit something sensible instead
  // of producing an empty step that would render as a blank row.
  const s = recordedActionToStepText({
    kind: "drag",
    selector: "#handle",
    label: "Slider",
    ts: 1,
  });
  assert.match(s, /User performs drag/);
});

test("never leaks raw role=…[name=\"…\"] or CSS selectors into the rendered step", () => {
  // Property-style guard: feed every supported kind a worst-case role
  // selector with no label, and assert the rendered step never contains the
  // raw `role=` token or the CSS-prefix tokens that make AI-generated steps
  // look engineer-shaped. This is the regression contract for PR #115.
  const kinds = ["click", "fill", "press", "select", "check", "uncheck"];
  for (const kind of kinds) {
    const s = recordedActionToStepText({
      kind,
      selector: 'role=button[name="Sign in"]',
      key: "Enter",
      value: "x",
      ts: 1,
    });
    assert.doesNotMatch(s, /role=[a-z]+\[/i, `${kind} step leaked raw role= selector: ${s}`);
    // Note: the friendlyTarget fallback successfully extracts "Sign in" from
    // `role=button[name="Sign in"]`, so the rendered step is allowed to
    // contain quoted "Sign in" — what it must NOT contain is the raw `role=`
    // token, the surrounding `[name="…"]` brackets, or a leading `#` / `.`
    // CSS prefix. The role= regex above covers the first two cases.
  }
});

// ── DIF-015 / PR #115: forwardInput CDP dispatch ─────────────────────────
// These tests verify the recorder's input-forwarding shim translates the
// frontend's CDP-shaped events into the correct Input.dispatchMouseEvent /
// Input.dispatchKeyEvent calls. The off-by-one mouse-button mapping was the
// P1 bug Devin Review caught (left-click → "none") so we lock down the
// numeric→string translation here.

await (async () => {
  console.log("\n🧪 recorder — forwardInput CDP dispatch");

  await asyncTest("rejects when session does not exist", async () => {
    await assert.rejects(
      forwardInput("REC-does-not-exist", { type: "mousePressed", x: 1, y: 1 }),
      /not found/i,
    );
  });

  await asyncTest("rejects when session has no CDP session attached", async () => {
    const dispose = _testSeedSession("REC-nocdp", { cdpSession: null });
    try {
      await assert.rejects(
        forwardInput("REC-nocdp", { type: "mousePressed", x: 1, y: 1 }),
        /no CDP session/i,
      );
    } finally { dispose(); }
  });

  await asyncTest("silently ignores input after status flips off 'recording'", async () => {
    // Once stopRecording flips status to "stopping" the sweep races with
    // any in-flight input from the canvas. We must drop those silently
    // instead of throwing CDP errors at the user post-stop.
    const cdp = makeFakeCdp();
    const dispose = _testSeedSession("REC-stopping", { status: "stopping", cdpSession: cdp });
    try {
      await forwardInput("REC-stopping", { type: "mousePressed", x: 1, y: 1, button: 0 });
      assert.equal(cdp.calls.length, 0, "no CDP calls should be made after stop");
    } finally { dispose(); }
  });

  await asyncTest("maps DOM button 0 → CDP 'left' (PR #115 P1 regression)", async () => {
    // The original implementation had `{0:"none",1:"left",2:"middle",3:"right"}`
    // which silently dropped every left-click. Lock down 0→left so that
    // regression cannot reappear.
    const cdp = makeFakeCdp();
    const dispose = _testSeedSession("REC-btn0", { cdpSession: cdp });
    try {
      await forwardInput("REC-btn0", { type: "mousePressed", x: 10, y: 20, button: 0, clickCount: 1 });
      assert.equal(cdp.calls.length, 1);
      assert.equal(cdp.calls[0].method, "Input.dispatchMouseEvent");
      assert.equal(cdp.calls[0].args.button, "left", "DOM button 0 must map to CDP 'left'");
      assert.equal(cdp.calls[0].args.type, "mousePressed");
      assert.equal(cdp.calls[0].args.x, 10);
      assert.equal(cdp.calls[0].args.y, 20);
      assert.equal(cdp.calls[0].args.clickCount, 1);
    } finally { dispose(); }
  });

  await asyncTest("maps DOM button 1 → CDP 'middle' and DOM 2 → CDP 'right'", async () => {
    const cdp = makeFakeCdp();
    const dispose = _testSeedSession("REC-btn12", { cdpSession: cdp });
    try {
      await forwardInput("REC-btn12", { type: "mousePressed", x: 0, y: 0, button: 1 });
      await forwardInput("REC-btn12", { type: "mousePressed", x: 0, y: 0, button: 2 });
      assert.equal(cdp.calls[0].args.button, "middle");
      assert.equal(cdp.calls[1].args.button, "right");
    } finally { dispose(); }
  });

  await asyncTest("dispatches CDP button 'none' for moves with no button held", async () => {
    // Hovering with no button down must not be interpreted as a left-drag.
    // The route caller (LiveBrowserView) omits `button` for idle moves, so
    // forwardInput must translate undefined → "none".
    const cdp = makeFakeCdp();
    const dispose = _testSeedSession("REC-hover", { cdpSession: cdp });
    try {
      await forwardInput("REC-hover", { type: "mouseMoved", x: 5, y: 5 });
      assert.equal(cdp.calls[0].args.button, "none");
    } finally { dispose(); }
  });

  await asyncTest("scroll events become Input.dispatchMouseEvent type=mouseWheel", async () => {
    const cdp = makeFakeCdp();
    const dispose = _testSeedSession("REC-scroll", { cdpSession: cdp });
    try {
      await forwardInput("REC-scroll", { type: "scroll", x: 100, y: 200, deltaX: 0, deltaY: -50 });
      assert.equal(cdp.calls[0].method, "Input.dispatchMouseEvent");
      assert.equal(cdp.calls[0].args.type, "mouseWheel");
      assert.equal(cdp.calls[0].args.deltaY, -50);
    } finally { dispose(); }
  });

  await asyncTest("keyDown forwards key/code/text via Input.dispatchKeyEvent", async () => {
    const cdp = makeFakeCdp();
    const dispose = _testSeedSession("REC-key", { cdpSession: cdp });
    try {
      await forwardInput("REC-key", { type: "keyDown", key: "Enter", code: "Enter", text: "" });
      assert.equal(cdp.calls[0].method, "Input.dispatchKeyEvent");
      assert.equal(cdp.calls[0].args.type, "keyDown");
      assert.equal(cdp.calls[0].args.key, "Enter");
    } finally { dispose(); }
  });

  await asyncTest("keyDown forwards windowsVirtualKeyCode for non-printable keys", async () => {
    // Backspace/Enter/Tab/Arrows only trigger their default action in CDP
    // when `windowsVirtualKeyCode` is set. The frontend supplies `e.keyCode`
    // and the shim must propagate it as both windows + native virtual codes.
    const cdp = makeFakeCdp();
    const dispose = _testSeedSession("REC-keycode", { cdpSession: cdp });
    try {
      await forwardInput("REC-keycode", { type: "keyDown", key: "Backspace", code: "Backspace", keyCode: 8 });
      assert.equal(cdp.calls[0].args.windowsVirtualKeyCode, 8);
      assert.equal(cdp.calls[0].args.nativeVirtualKeyCode, 8);
    } finally { dispose(); }
  });

  await asyncTest("keyDown omits virtual keycode fields when keyCode is missing", async () => {
    // Char-only sources (e.g. older clients) shouldn't send 0/undefined as
    // the virtual code — that would tell CDP "no key" and break dispatch.
    const cdp = makeFakeCdp();
    const dispose = _testSeedSession("REC-nokeycode", { cdpSession: cdp });
    try {
      await forwardInput("REC-nokeycode", { type: "keyDown", key: "a", code: "KeyA", text: "a" });
      assert.equal(cdp.calls[0].args.windowsVirtualKeyCode, undefined);
      assert.equal(cdp.calls[0].args.nativeVirtualKeyCode, undefined);
    } finally { dispose(); }
  });

  await asyncTest("keyUp omits text even when caller supplies it", async () => {
    // CDP rejects key events that include `text` on a keyUp. The shim must
    // strip it regardless of what the caller sends.
    const cdp = makeFakeCdp();
    const dispose = _testSeedSession("REC-keyup", { cdpSession: cdp });
    try {
      await forwardInput("REC-keyup", { type: "keyUp", key: "a", code: "KeyA", text: "a" });
      assert.equal(cdp.calls[0].args.text, "");
    } finally { dispose(); }
  });

  await asyncTest("char events forward text via Input.dispatchKeyEvent type=char", async () => {
    const cdp = makeFakeCdp();
    const dispose = _testSeedSession("REC-char", { cdpSession: cdp });
    try {
      await forwardInput("REC-char", { type: "char", text: "x" });
      assert.equal(cdp.calls[0].args.type, "char");
      assert.equal(cdp.calls[0].args.text, "x");
    } finally { dispose(); }
  });

  await asyncTest("CDP send errors are swallowed (transient page-navigation race)", async () => {
    // CDP calls fail when the page is navigating mid-event; the shim must
    // not bubble that up to the user-facing route or the recorder UI would
    // surface phantom errors during normal navigation.
    const cdp = {
      async send() { throw new Error("Target closed"); },
    };
    const dispose = _testSeedSession("REC-err", { cdpSession: cdp });
    try {
      await assert.doesNotReject(
        forwardInput("REC-err", { type: "mousePressed", x: 1, y: 1, button: 0 }),
      );
    } finally { dispose(); }
  });
})();

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n⚠️  recorder tests failed");
  process.exit(1);
}

console.log("\n🎉 All recorder tests passed!");
