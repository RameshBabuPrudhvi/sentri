/**
 * @module runner/recorder
 * @description DIF-015 — Interactive browser recorder for test creation.
 *
 * Opens a Playwright browser pointed at the project's URL, streams a
 * live CDP screencast to the frontend via SSE (reusing the existing
 * `emitRunEvent` channel), and captures raw user interactions
 * (clicks, fills, key-presses, navigations) as Playwright actions.
 *
 * On stop, the captured action list is transformed into a Playwright
 * test body and returned so the caller (routes/tests.js) can persist
 * a Draft test and run it through the rest of the generation pipeline
 * (assertion enhancement, self-healing transform) just like any other
 * AI-generated test.
 *
 * ### Exports
 * - {@link startRecording}  — Launch browser + begin capture.
 * - {@link stopRecording}   — Stop capture; return `{ actions, playwrightCode }`.
 * - {@link getRecording}    — Inspect an in-flight recording (for abort / status).
 *
 * ### Design notes
 * Capture is done entirely in the **page context** via a single injected
 * listener that posts events back to Node through `page.exposeBinding`.
 * This is the same approach Playwright's own `codegen` uses for JavaScript
 * action recording, minus the DevTools UI — we only need the raw event
 * stream.
 */

import { launchBrowser, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, NAVIGATION_TIMEOUT } from "./config.js";
import { startScreencast } from "./screencast.js";
import { formatLogLine } from "../utils/logFormatter.js";
import * as runRepo from "../database/repositories/runRepo.js";

// Hard cap for how long a single recording session may stay open. Defence-in-
// depth for the case where a client disconnects without hitting stop/discard
// (e.g. browser tab closed, network cut). After this timeout the server tears
// down the Chromium process and deletes the session from the map.
const MAX_RECORDING_MS = Math.max(60_000, parseInt(process.env.MAX_RECORDING_MS || "1800000", 10) || 1_800_000);

/**
 * @typedef {Object} RecordedAction
 * @property {"goto"|"click"|"fill"|"press"|"select"|"check"|"uncheck"} kind
 * @property {string} [selector]   - Best-effort role/label/text/css selector.
 * @property {string} [value]      - For `fill`, the final value typed.
 * @property {string} [url]        - For `goto`.
 * @property {string} [key]        - For `press`.
 * @property {number}  ts          - Epoch ms when the action was captured.
 */

/**
 * @typedef {Object} RecordingSession
 * @property {string}  id
 * @property {string}  projectId
 * @property {string}  url               - Starting URL.
 * @property {"recording"|"stopping"|"stopped"} status
 * @property {Array<RecordedAction>} actions
 * @property {number}  startedAt
 * @property {Object}  [browser]         - Playwright Browser (internal).
 * @property {Object}  [context]         - Playwright BrowserContext (internal).
 * @property {Object}  [page]            - Playwright Page (internal).
 * @property {Function} [stopScreencast]  - Cleanup fn returned by startScreencast.
 * @property {Object}  [cdpSession]      - CDP session for input forwarding.
 */

/** @type {Map<string, RecordingSession>} */
const sessions = new Map();

/**
 * @typedef {Object} CompletedRecording
 * @property {string}  projectId
 * @property {Array<RecordedAction>} actions
 * @property {string}  playwrightCode
 * @property {string}  url
 * @property {number}  completedAt
 * @property {"auto_timeout"|"manual"} reason
 */

/**
 * Short-lived cache of recordings torn down by the MAX_RECORDING_MS safety-net
 * timeout. Entries live for `COMPLETED_TTL_MS` so a user who clicks
 * "Stop & Save" moments after the timeout fires can still recover their
 * captured actions instead of losing them to a 500 error. Scoped to the in-
 * process recorder so no external store is needed.
 * @type {Map<string, CompletedRecording>}
 */
const completedSessions = new Map();
const COMPLETED_TTL_MS = Math.max(10_000, parseInt(process.env.RECORDER_COMPLETED_TTL_MS || "120000", 10) || 120_000);

/**
 * JS source injected into every page frame. It captures pointer/keyboard
 * events and relays them to Node via the `__sentriRecord` binding. We
 * de-duplicate by dispatch target + event type so that a single click
 * doesn't emit multiple entries when bubbling through the DOM.
 *
 * `bestSelector` intentionally mirrors Playwright's own heuristics loosely:
 * prefer role-based selectors, then data-testid, then aria-label, then
 * a short CSS chain.
 */
const RECORDER_SCRIPT = `
(() => {
  if (window.__sentriRecorderInstalled) return;
  window.__sentriRecorderInstalled = true;

  function bestSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.getAttribute("data-testid")) return '[data-testid="' + el.getAttribute("data-testid") + '"]';
    const role = el.getAttribute("role") || roleFromTag(el.tagName);
    const label = (el.getAttribute("aria-label") || el.innerText || "").trim().slice(0, 50);
    if (role && label) return 'role=' + role + '[name="' + label.replace(/"/g, '\\\\"') + '"]';
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
    const cls = (el.className && typeof el.className === "string") ? el.className.split(/\\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + (cls ? "." + cls : "");
  }
  function roleFromTag(tag) {
    tag = (tag || "").toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "input" || tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    return "";
  }

  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("a, button, input, [role], [data-testid]") || ev.target;
    window.__sentriRecord && window.__sentriRecord({
      kind: "click", selector: bestSelector(el), ts: Date.now(),
    });
  }, true);

  document.addEventListener("change", (ev) => {
    const el = ev.target;
    if (!el) return;
    if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
      window.__sentriRecord && window.__sentriRecord({
        kind: el.checked ? "check" : "uncheck",
        selector: bestSelector(el),
        ts: Date.now(),
      });
    } else if (el.tagName === "SELECT") {
      window.__sentriRecord && window.__sentriRecord({
        kind: "select", selector: bestSelector(el), value: el.value, ts: Date.now(),
      });
    } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      window.__sentriRecord && window.__sentriRecord({
        kind: "fill", selector: bestSelector(el), value: el.value, ts: Date.now(),
      });
    }
  }, true);

  document.addEventListener("keydown", (ev) => {
    // Only capture "meaningful" keys — skip modifier-only taps so we don't
    // spam the timeline. Enter, Escape, Tab, and arrows are useful; everything
    // else is already captured via "change" on input/textarea elements.
    const interestingKeys = ["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!interestingKeys.includes(ev.key)) return;
    window.__sentriRecord && window.__sentriRecord({
      kind: "press", key: ev.key, selector: bestSelector(ev.target), ts: Date.now(),
    });
  }, true);
})();
`;

/**
 * Escape a user-controlled string so it can be safely interpolated into a
 * JavaScript single-quoted string literal in generated source code. Handles
 * backslash (`\`), single quote (`'`), newline (`\n`), carriage return (`\r`),
 * line/paragraph separators (U+2028 / U+2029 — these break literals in most
 * engines), and other C0 control characters via `\xHH` escapes.
 *
 * Order matters: backslash must be escaped first, otherwise subsequent
 * replacements would double-escape their own inserted backslashes.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeJsSingleQuote(str) {
  return String(str ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    // Any remaining C0 / DEL control byte → \xHH. These would either break
    // the literal (e.g. U+0008) or render untrustworthy generated code.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * Render a captured action as a short, human-readable step sentence so the
 * recorder's persisted `steps` array aligns visually with the AI generate /
 * crawl pipeline output (`outputSchema.js`) and the manual-test creation path
 * — both of which produce English prose like "User clicks the Sign Up button".
 *
 * Recorded actions only carry a CDP-style selector and (optionally) a typed
 * value, so these sentences are best-effort: we surface the selector as the
 * "target" verbatim. The Test Detail page renders all three sources through
 * the same Steps panel, and previously the recorder was the only producer
 * emitting engineer-shaped strings ("Step 1: click → #login"), making
 * recorded tests stick out and look broken to manual reviewers.
 *
 * @param {RecordedAction} a
 * @returns {string} A single step sentence suitable for the persisted `steps[]` array.
 */
export function recordedActionToStepText(a) {
  const target = a.selector ? ` ${a.selector}` : "";
  switch (a.kind) {
    case "goto":
      return `User navigates to ${a.url || ""}`.trim();
    case "click":
      return `User clicks${target}`;
    case "fill":
      // Recorded fill values can contain secrets (passwords, API keys). The
      // raw value already lives in `playwrightCode`; truncate aggressively in
      // the human-readable steps so the Test Detail page doesn't surface it.
      return `User fills${target} with "${String(a.value || "").slice(0, 40)}"`;
    case "press":
      return `User presses ${a.key || ""}`.trim();
    case "select":
      return `User selects "${String(a.value || "").slice(0, 40)}" in${target}`;
    case "check":
      return `User checks${target}`;
    case "uncheck":
      return `User unchecks${target}`;
    default:
      // Fall back to the action kind so unknown future kinds still show
      // something — better than emitting an empty string into the steps list.
      return `User performs ${a.kind || "action"}${target}`;
  }
}

/**
 * Convert a list of captured actions into a Playwright test body. The output
 * is wrapped in the repo-standard `test(...)` shape so the existing runner
 * (codeExecutor, codeParsing) treats it like any AI-generated test.
 *
 * @param {string} testName
 * @param {string} startUrl
 * @param {Array<RecordedAction>} actions
 * @returns {string} Playwright source code.
 */
export function actionsToPlaywrightCode(testName, startUrl, actions) {
  const safeName = escapeJsSingleQuote(testName || "Recorded test");
  const safeStartUrl = escapeJsSingleQuote(startUrl || "");
  const lines = [];
  lines.push(`await page.goto('${safeStartUrl}');`);
  // `startRecording` always pushes an initial `goto` to startUrl as actions[0]
  // (and `framenavigated` can echo the same URL). We emit the initial goto
  // above, so suppress any subsequent consecutive gotos to the same URL to
  // avoid duplicate navigation in the generated script.
  let lastGotoUrl = String(startUrl || "");
  let stepNo = 1;
  for (const a of actions) {
    const sel = escapeJsSingleQuote(a.selector || "");
    if (a.kind === "goto" && a.url) {
      if (a.url === lastGotoUrl) continue;
      lastGotoUrl = a.url;
      const safeUrl = escapeJsSingleQuote(a.url);
      lines.push(`// Step ${stepNo}: Navigate`);
      lines.push(`await page.goto('${safeUrl}');`);
    } else if (a.kind === "click" && sel) {
      lines.push(`// Step ${stepNo}: Click element`);
      lines.push(`await safeClick(page, '${sel}');`);
    } else if (a.kind === "fill" && sel) {
      lines.push(`// Step ${stepNo}: Fill field`);
      lines.push(`await safeFill(page, '${sel}', '${escapeJsSingleQuote(a.value || "")}');`);
    } else if (a.kind === "press" && a.key) {
      lines.push(`// Step ${stepNo}: Press ${escapeJsSingleQuote(a.key)}`);
      lines.push(`await page.keyboard.press('${escapeJsSingleQuote(a.key)}');`);
    } else if (a.kind === "select" && sel) {
      // Route through the self-healing helper so recorded selects benefit
      // from the safeSelect waterfall (getByLabel → getByRole('combobox') →
      // aria-label fallback). `applyHealingTransforms` won't rewrite a raw
      // `page.selectOption('#css', ...)` because `bestSelector()` always
      // produces CSS-looking output, so emit `safeSelect` directly here to
      // stay consistent with how `safeClick` and `safeFill` are handled
      // above.
      lines.push(`// Step ${stepNo}: Select option`);
      lines.push(`await safeSelect(page, '${sel}', '${escapeJsSingleQuote(a.value || "")}');`);
    } else if ((a.kind === "check" || a.kind === "uncheck") && sel) {
      // Same rationale as safeSelect above — the recorder's CSS-looking
      // selectors bypass the applyHealingTransforms regex guard, so emit
      // safeCheck/safeUncheck directly. These helpers gained list/row
      // scoped fallbacks in PR #103 for TodoMVC-style patterns, which
      // recorded checkboxes benefit from for free.
      lines.push(`// Step ${stepNo}: ${a.kind === "check" ? "Check" : "Uncheck"}`);
      lines.push(`await ${a.kind === "check" ? "safeCheck" : "safeUncheck"}(page, '${sel}');`);
    } else {
      continue;
    }
    stepNo++;
  }
  lines.push(`// Step ${stepNo}: Verify page is still reachable`);
  lines.push(`await expect(page).toHaveURL(/.*/);`);

  return (
    `import { test, expect } from '@playwright/test';\n\n` +
    `test('${safeName}', async ({ page }) => {\n` +
    lines.map(l => "  " + l).join("\n") +
    "\n});\n"
  );
}

/**
 * Start a new interactive recording session. Opens a Playwright browser,
 * navigates to `startUrl`, installs the capture script, and begins a CDP
 * screencast on the given session ID (reused as the SSE run ID).
 *
 * @param {Object} args
 * @param {string} args.sessionId   - Unique ID used for SSE + session tracking.
 * @param {string} args.projectId
 * @param {string} args.startUrl
 * @returns {Promise<RecordingSession>}
 */
export async function startRecording({ sessionId, projectId, startUrl }) {
  if (sessions.has(sessionId)) {
    throw new Error(`Recording session ${sessionId} is already active.`);
  }
  if (!startUrl || !/^https?:\/\//i.test(startUrl)) {
    throw new Error("startUrl must be a valid http(s) URL.");
  }

  const browser = await launchBrowser();
  let context;
  let page;
  try {
    context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
    });

    const session = /** @type {RecordingSession} */ ({
      id: sessionId,
      projectId,
      url: startUrl,
      status: "recording",
      actions: [],
      startedAt: Date.now(),
      browser,
      context,
    });

    page = await context.newPage();
    session.page = page;

    // Expose a binding for the injected script to relay captured events.
    await context.exposeBinding("__sentriRecord", (_source, action) => {
      if (session.status !== "recording") return;
      if (!action || typeof action !== "object") return;
      session.actions.push({
        kind: String(action.kind || ""),
        selector: action.selector ? String(action.selector).slice(0, 200) : undefined,
        value: action.value != null ? String(action.value).slice(0, 500) : undefined,
        url: action.url ? String(action.url) : undefined,
        key: action.key ? String(action.key) : undefined,
        ts: Number(action.ts) || Date.now(),
      });
    });
    await context.addInitScript(RECORDER_SCRIPT);

    // Navigate to the starting URL and record it as the first action.
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT }).catch(() => {});
    session.actions.push({ kind: "goto", url: startUrl, ts: Date.now() });

    // Capture subsequent in-page navigations (form submit, link click that
    // triggers a full load) so the generated script replays them via goto.
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && frame.url() && frame.url() !== "about:blank") {
        session.actions.push({ kind: "goto", url: frame.url(), ts: Date.now() });
      }
    });

    // Start CDP screencast so the RecorderModal can show the live browser.
    // startScreencast now returns { stop, cdpSession } — store both so the
    // recorder can forward mouse/keyboard events from the canvas overlay.
    const screencastResult = await startScreencast(page, sessionId);
    if (screencastResult) {
      session.stopScreencast = screencastResult.stop;
      session.cdpSession = screencastResult.cdpSession;
    }

    // Defence-in-depth: if the client never calls stop/discard (e.g. tab
    // closed, network died) the browser would remain open forever. Force-kill
    // the session after `MAX_RECORDING_MS` so we never leak Chromium.
    session.idleTimeout = setTimeout(async () => {
      console.error(formatLogLine("warn", null, `[recorder] session ${sessionId} exceeded MAX_RECORDING_MS (${MAX_RECORDING_MS}ms) — auto-tearing down`));
      try {
        const result = await stopRecording(sessionId);
        // Stash the generated test so a user who hits "Stop & Save" right
        // after the timeout fires doesn't lose their captured actions.
        completedSessions.set(sessionId, {
          projectId: session.projectId,
          actions: result.actions,
          playwrightCode: result.playwrightCode,
          url: result.url,
          completedAt: Date.now(),
          reason: "auto_timeout",
        });
        const purge = setTimeout(() => completedSessions.delete(sessionId), COMPLETED_TTL_MS);
        purge.unref?.();
      } catch { /* session may already be gone; nothing to stash */ }
      // Close out the stub `runs` row created by POST /record. Without this,
      // the row stays in `status: "running"` forever and the partial unique
      // index `idx_runs_one_active_per_project` blocks every future run on
      // this project (crawl/test_run/generate report opaque UNIQUE errors;
      // the next recorder launch's orphan sweep is the only path that
      // recovers, but only for `record` rows).
      try {
        runRepo.update(sessionId, {
          status: "interrupted",
          finishedAt: new Date().toISOString(),
          error: `Recorder exceeded MAX_RECORDING_MS (${MAX_RECORDING_MS}ms) — auto-torn-down`,
        });
      } catch { /* row may not exist (e.g. tests that bypass route layer) */ }
    }, MAX_RECORDING_MS);
    // Node's timer would keep the process alive; recorder sessions are
    // per-request resources, so let the event loop exit if everything else
    // is quiescent.
    session.idleTimeout.unref?.();

    // Only publish the session after all async setup has succeeded —
    // otherwise the caller never learns the sessionId to stop and the
    // browser would leak permanently.
    sessions.set(sessionId, session);
    return session;
  } catch (err) {
    // Tear down any partial Playwright resources so we don't leak a
    // Chromium process when setup fails mid-way.
    try { await page?.close(); } catch { /* ignore */ }
    try { await context?.close(); } catch { /* ignore */ }
    try { await browser?.close(); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Look up an in-flight recording session.
 * @param {string} sessionId
 * @returns {RecordingSession|null}
 */
export function getRecording(sessionId) {
  return sessions.get(sessionId) || null;
}

/**
 * Look up and remove a recording that was auto-torn-down by the safety-net
 * timeout. Returns `null` if no such recording is cached (either never timed
 * out, or the TTL has expired). The entry is removed on read so callers get
 * at-most-once delivery of the captured actions.
 *
 * @param {string} sessionId
 * @returns {CompletedRecording|null}
 */
export function takeCompletedRecording(sessionId) {
  const entry = completedSessions.get(sessionId);
  if (!entry) return null;
  completedSessions.delete(sessionId);
  return entry;
}

/**
 * Test-only seam: install a fake recording session keyed by `sessionId` so
 * unit tests can exercise {@link forwardInput} (and its CDP dispatch logic)
 * without launching a real Chromium. Returns a disposer that removes the
 * session from the in-memory map.
 *
 * Intentionally not part of the public API — only the module's own test file
 * imports this. The `_test` prefix and JSDoc tag should keep it out of normal
 * usage; reviewers should reject any non-test caller.
 *
 * @param {string} sessionId
 * @param {Object} fields - Partial RecordingSession fields to seed.
 * @returns {Function} Disposer `() => void` that deletes the seeded session.
 * @private
 */
export function _testSeedSession(sessionId, fields = {}) {
  sessions.set(sessionId, {
    id: sessionId,
    projectId: fields.projectId ?? "TEST-PROJECT",
    url: fields.url ?? "https://example.com",
    status: fields.status ?? "recording",
    actions: [],
    startedAt: Date.now(),
    cdpSession: fields.cdpSession,
    ...fields,
  });
  return () => sessions.delete(sessionId);
}

/**
 * Forward a user input event from the canvas overlay to the headless browser
 * via CDP Input domain commands. This is the core mechanism that makes the
 * recorder interactive — without it the canvas is read-only and the user can
 * never produce actions in the headless browser.
 *
 * Supported event types:
 *   mousePressed / mouseReleased / mouseMoved  → Input.dispatchMouseEvent
 *   keyDown / keyUp / char                     → Input.dispatchKeyEvent
 *   scroll                                     → Input.dispatchMouseEvent (wheel)
 *
 * @param {string} sessionId
 * @param {Object} event
 * @param {"mousePressed"|"mouseReleased"|"mouseMoved"|"keyDown"|"keyUp"|"char"|"scroll"} event.type
 * @param {number} [event.x]          - Viewport x (already scaled by caller).
 * @param {number} [event.y]          - Viewport y (already scaled by caller).
 * @param {number} [event.button]     - DOM MouseEvent.button: 0=left, 1=middle, 2=right.
 *                                      Pass `undefined` (omit) for moves with no
 *                                      button held — CDP requires `"none"` then.
 * @param {number} [event.clickCount] - 1 for single click.
 * @param {number} [event.deltaX]     - Horizontal scroll delta.
 * @param {number} [event.deltaY]     - Vertical scroll delta.
 * @param {string} [event.key]        - DOM key name, e.g. "Enter".
 * @param {string} [event.code]       - DOM code, e.g. "KeyA".
 * @param {number} [event.keyCode]    - DOM virtual keycode (`e.keyCode`).
 *                                      Required for non-printable keys —
 *                                      without it CDP fires keyDown but
 *                                      Backspace/Enter/Tab/Arrows have no
 *                                      effect on the page.
 * @param {string} [event.text]       - Printable text for char events.
 * @param {number} [event.modifiers]  - Bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
 * @returns {Promise<void>}
 * @throws {Error} When the session is not found or has no CDP session.
 */
export async function forwardInput(sessionId, event) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Recording session ${sessionId} not found.`);
  if (!session.cdpSession) throw new Error(`Session ${sessionId} has no CDP session — cannot forward input.`);
  if (session.status !== "recording") return; // ignore input after stop is called

  const cdp = session.cdpSession;
  const { type } = event;

  try {
    if (type === "mousePressed" || type === "mouseReleased" || type === "mouseMoved") {
      // DOM MouseEvent.button: 0=left, 1=middle, 2=right. CDP uses string
      // names. For `mouseMoved` with no button held the caller should omit
      // `event.button` so we dispatch `"none"` — otherwise CDP interprets a
      // numeric 0 as a held left-button and treats the move as a drag.
      const buttonMap = { 0: "left", 1: "middle", 2: "right" };
      const cdpButton = event.button == null ? "none" : (buttonMap[event.button] ?? "none");
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        x: Math.round(event.x ?? 0),
        y: Math.round(event.y ?? 0),
        button: cdpButton,
        clickCount: event.clickCount ?? (type === "mousePressed" ? 1 : 0),
        modifiers: event.modifiers ?? 0,
      });
    } else if (type === "scroll") {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(event.x ?? 0),
        y: Math.round(event.y ?? 0),
        deltaX: event.deltaX ?? 0,
        deltaY: event.deltaY ?? 0,
        modifiers: event.modifiers ?? 0,
      });
    } else if (type === "keyDown" || type === "keyUp") {
      // `windowsVirtualKeyCode` is what makes Backspace/Enter/Tab/Arrows
      // actually trigger their default action in the page. Without it CDP
      // fires the event but the page receives no operation. The frontend
      // forwards `e.keyCode` from the DOM event for this purpose.
      const args = {
        type,
        key: event.key ?? "",
        code: event.code ?? "",
        text: type === "keyDown" ? (event.text ?? "") : "",
        modifiers: event.modifiers ?? 0,
      };
      if (typeof event.keyCode === "number" && event.keyCode > 0) {
        args.windowsVirtualKeyCode = event.keyCode;
        args.nativeVirtualKeyCode = event.keyCode;
      }
      await cdp.send("Input.dispatchKeyEvent", args);
    } else if (type === "char") {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "char",
        key: event.text ?? "",
        text: event.text ?? "",
        modifiers: event.modifiers ?? 0,
      });
    }
  } catch (err) {
    // CDP errors (e.g. page navigating mid-click) are transient — don't crash
    // the session. Log at debug level so they don't flood production logs.
    if (process.env.LOG_LEVEL === "debug") {
      console.error(formatLogLine("debug", null, `[recorder] forwardInput CDP error: ${err.message}`));
    }
  }
}

/**
 *
 * @param {string} sessionId
 * @param {Object} [opts]
 * @param {string} [opts.testName] - Optional name to embed in the generated test.
 * @returns {Promise<{ actions: Array<RecordedAction>, playwrightCode: string, url: string }>}
 * @throws {Error} When the session does not exist.
 */
export async function stopRecording(sessionId, opts = {}) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Recording session ${sessionId} not found.`);
  session.status = "stopping";

  try {
    if (session.idleTimeout) { clearTimeout(session.idleTimeout); session.idleTimeout = null; }
    if (session.stopScreencast) await session.stopScreencast().catch(() => {});
    await session.page?.close().catch(() => {});
    await session.context?.close().catch(() => {});
    await session.browser?.close().catch(() => {});
  } finally {
    session.status = "stopped";
    sessions.delete(sessionId);
  }

  const testName = opts.testName || `Recorded flow @ ${new Date().toISOString()}`;
  const playwrightCode = actionsToPlaywrightCode(testName, session.url, session.actions);
  return { actions: session.actions, playwrightCode, url: session.url };
}
