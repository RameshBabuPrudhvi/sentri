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
  const safeName = String(testName || "Recorded test").replace(/'/g, "\\'");
  const safeStartUrl = String(startUrl || "").replace(/'/g, "\\'");
  const lines = [];
  lines.push(`await page.goto('${safeStartUrl}');`);
  // `startRecording` always pushes an initial `goto` to startUrl as actions[0]
  // (and `framenavigated` can echo the same URL). We emit the initial goto
  // above, so suppress any subsequent consecutive gotos to the same URL to
  // avoid duplicate navigation in the generated script.
  let lastGotoUrl = String(startUrl || "");
  let stepNo = 1;
  for (const a of actions) {
    const sel = (a.selector || "").replace(/'/g, "\\'");
    if (a.kind === "goto" && a.url) {
      if (a.url === lastGotoUrl) continue;
      lastGotoUrl = a.url;
      const safeUrl = String(a.url).replace(/'/g, "\\'");
      lines.push(`// Step ${stepNo}: Navigate`);
      lines.push(`await page.goto('${safeUrl}');`);
    } else if (a.kind === "click" && sel) {
      lines.push(`// Step ${stepNo}: Click element`);
      lines.push(`await safeClick(page, '${sel}');`);
    } else if (a.kind === "fill" && sel) {
      lines.push(`// Step ${stepNo}: Fill field`);
      lines.push(`await safeFill(page, '${sel}', '${(a.value || "").replace(/'/g, "\\'")}');`);
    } else if (a.kind === "press" && a.key) {
      lines.push(`// Step ${stepNo}: Press ${a.key}`);
      lines.push(`await page.keyboard.press('${a.key}');`);
    } else if (a.kind === "select" && sel) {
      lines.push(`// Step ${stepNo}: Select option`);
      lines.push(`await page.selectOption('${sel}', '${(a.value || "").replace(/'/g, "\\'")}');`);
    } else if ((a.kind === "check" || a.kind === "uncheck") && sel) {
      lines.push(`// Step ${stepNo}: ${a.kind === "check" ? "Check" : "Uncheck"}`);
      lines.push(`await page.${a.kind === "check" ? "check" : "uncheck"}('${sel}');`);
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
    session.stopScreencast = await startScreencast(page, sessionId);

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
 * Stop an in-flight recording. Tears down the browser and returns the
 * captured actions plus a ready-to-persist Playwright test body.
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
