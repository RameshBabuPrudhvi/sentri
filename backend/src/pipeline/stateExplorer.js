/**
 * @module pipeline/stateExplorer
 * @description State-based exploration engine — discovers multi-step user
 * flows by executing real UI actions and tracking state transitions.
 *
 * ### Reuses
 * - `pipeline/pageSnapshot.takeSnapshot` — DOM snapshot capture
 * - `pipeline/smartCrawl.extractPathPattern` — path normalisation
 * - `pipeline/stateFingerprint.fingerprintState` — state identity
 * - `pipeline/actionDiscovery.discoverActions` — action enumeration
 * - `pipeline/flowGraph.extractFlows` / `flowToJourney` — flow extraction
 * - `utils/abortHelper.throwIfAborted` — abort signal support
 * - `utils/runLogger.*` — SSE logging
 *
 * ### Tuning (from Test Dials → `options.explorerTuning`)
 * | Parameter       | Range       | Default | Description                          |
 * |-----------------|-------------|---------|--------------------------------------|
 * | `maxStates`     | 5–100       | 30      | Max unique states before stopping    |
 * | `maxDepth`      | 1–10        | 3       | Exploration depth from start URL     |
 * | `maxActions`    | 1–20        | 8       | Actions to try per state             |
 * | `actionTimeout` | 1000–15000  | 5000    | Per-action timeout in ms             |
 *
 * ### Exports
 * - {@link exploreStates} — full state exploration from a project URL
 */

import { throwIfAborted } from "../utils/abortHelper.js";
import { takeSnapshot } from "./pageSnapshot.js";
import { fingerprintState, statesEqual } from "./stateFingerprint.js";
import { discoverActions, detectSignupIntent } from "./actionDiscovery.js";
import { fillEmailVerificationFlow, waitForVerification, dispose } from "../utils/disposableEmail.js";
import { extractFlows, flowToJourney } from "./flowGraph.js";
import { extractPathPatternWithParams, stripNoiseParams } from "./smartCrawl.js";
import { log, logWarn, logSuccess, emitRunEvent } from "../utils/runLogger.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as crawlSnapshotRepo from "../database/repositories/crawlSnapshotRepo.js";
import { signRunArtifacts } from "../middleware/appSetup.js";
import { decryptCredentials } from "../utils/credentialEncryption.js";
import { performAutoLogin } from "./autoLogin.js";
import { createHarCapture, summariseApiEndpoints } from "./harCapture.js";
import { launchBrowser } from "../runner/config.js";
import { loadRobotsRules, isAllowed, loadSitemapUrls } from "../utils/robotsSitemap.js";
// Bundle-A fix #19 — bot-detection patterns sourced from the shared module
// so the crawl-time gate stays in lockstep with `feedbackLoop.js`'s post-run
// BOT_BLOCK classifier. Pre-fix the two lists drifted: `feedbackLoop.js`
// carried the `\/blocked(?:[/?#]|$)` boundary fix while this module had a
// looser `\/blocked/i` pattern that over-matched legitimate `/blocked-users`
// admin paths. See `utils/botDetection.js` for the full rationale.
import { EXPLORER_BOT_DETECTION_PATTERNS } from "../utils/botDetection.js";
import {
  explorerStatesDiscoveredTotal,
  explorerActionsAttemptedTotal,
  explorerBotBlockSkipsTotal,
  explorerGlobalTimeoutTotal,
  explorerDurationSeconds,
} from "../utils/metrics.js";

// Defaults — overridden per-run by tuning values from Test Dials
const DEFAULT_MAX_STATES = parseInt(process.env.CRAWL_MAX_PAGES, 10) || 30;
const DEFAULT_MAX_DEPTH  = parseInt(process.env.CRAWL_MAX_DEPTH, 10) || 3;
const DEFAULT_MAX_ACTIONS = 8;
const DEFAULT_ACTION_TIMEOUT = 5000;

// Bundle-A fix #19 — bot-detection pattern list now sourced from the shared
// module so the crawl-time gate and the post-run failure classifier never
// drift apart. The explorer-specific HTTP-error patterns (/error, /403, /429)
// + Google SSO interstitial are included via `EXPLORER_BOT_DETECTION_PATTERNS`.
const BOT_DETECTION_PATTERNS = EXPLORER_BOT_DETECTION_PATTERNS;

/**
 * Normalise a hostname for origin comparison by stripping the `www.` prefix.
 * This treats `google.com` and `www.google.com` as the same origin, which is
 * correct for virtually all real-world sites (they redirect between the two).
 *
 * @param {string} hostname
 * @returns {string}
 */
function normaliseHost(hostname) {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

/**
 * Check if two URLs share the same effective origin (protocol + normalised host).
 * Treats `www.example.com` and `example.com` as equivalent.
 *
 * @param {string} urlA
 * @param {string} urlB
 * @returns {boolean}
 */
function isSameEffectiveOrigin(urlA, urlB) {
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    return a.protocol === b.protocol && normaliseHost(a.hostname) === normaliseHost(b.hostname) && a.port === b.port;
  } catch { return false; }
}

/**
 * Check if the current page URL is still on the same origin as the project.
 * Returns false if the action navigated to a third-party domain, a bot
 * detection page, or an error page.
 *
 * Treats www/non-www as equivalent (e.g. google.com ≡ www.google.com).
 *
 * @param {string} currentUrl — page.url() after the action
 * @param {string} projectOrigin — the resolved project origin (after redirect)
 * @returns {boolean}
 */
function isSameOriginAndValid(currentUrl, projectOrigin) {
  try {
    if (!isSameEffectiveOrigin(currentUrl, projectOrigin)) return false;
    if (BOT_DETECTION_PATTERNS.some(re => re.test(currentUrl))) return false;
    return true;
  } catch { return false; }
}

async function resolveElement(page, selectors, timeout) {
  for (const sel of selectors) {
    try {
      const locator = page.locator(sel).first();
      await locator.waitFor({ state: "visible", timeout });
      return locator;
    } catch { /* next strategy */ }
  }
  return null;
}

async function executeAction(page, action, actionTimeout) {
  const el = await resolveElement(page, action.selectors, actionTimeout);
  if (!el) return false;
  try {
    switch (action.type) {
      case "click": case "submit":
        await el.click({ timeout: actionTimeout }); break;
      case "fill":
        // Bundle-B fix #17 — `.fill(value)` already clears the field. The
        // intermediate `el.fill("")` was a no-op that fired an extra
        // onChange event on React Hook Form / controlled inputs, throwing
        // off form validation and double-counting field-touch metrics.
        if (action.value) { await el.fill(action.value); } else { return false; } break;
      case "select":
        await el.selectOption({ index: 1 }).catch(() => {}); break;
      case "check":
        await el.check({ timeout: actionTimeout }).catch(() =>
          el.click({ timeout: actionTimeout })
        ); break;
      default: return false;
    }
    return true;
  } catch { return false; }
}

async function waitForSettle(page, actionTimeout) {
  await page.waitForLoadState("domcontentloaded", { timeout: actionTimeout }).catch(() => {});
  await page.waitForTimeout(300);
}

function groupActionsByForm(actions) {
  const formGroups = new Map();
  const standalone = [];
  for (const action of actions) {
    if (action.formId && ["fill", "submit", "check", "select"].includes(action.type)) {
      if (!formGroups.has(action.formId)) formGroups.set(action.formId, []);
      formGroups.get(action.formId).push(action);
    } else {
      standalone.push(action);
    }
  }
  return { formGroups, standalone };
}

async function executeFormGroup(page, formActions, actionTimeout) {
  const executed = [];
  const typeOrder = { fill: 0, check: 1, select: 1, submit: 2, click: 2 };
  const sorted = [...formActions].sort((a, b) => (typeOrder[a.type] || 3) - (typeOrder[b.type] || 3));
  for (const action of sorted) {
    if (await executeAction(page, action, actionTimeout)) executed.push(action);
  }
  return executed;
}

// ── Per-URL state cap (#52 defect #6) ────────────────────────────────────────
// Base cap per URL path pattern. The actual cap scales up when existing states
// at the same URL are structurally diverse (different DOM structure or component
// inventory), which indicates a multi-step wizard or SPA with meaningful
// in-page state changes. This replaces the previous hard cap of 3.
const BASE_STATES_PER_URL = 3;
const MAX_STATES_PER_URL  = 8;

/**
 * Compute the effective per-URL state cap based on fingerprint diversity.
 *
 * If the existing states at this URL all have different DOM structures or
 * component inventories, the cap is raised to allow deeper exploration of
 * multi-step wizards and SPA flows. If the states are structurally similar
 * (same DOM, different timestamps), the base cap applies.
 *
 * @param {Array} existingSnapshots — snapshots already captured at this URL
 * @returns {number} effective cap for this URL
 */
function effectiveUrlCap(existingSnapshots) {
  if (existingSnapshots.length < BASE_STATES_PER_URL) return BASE_STATES_PER_URL;
  // Count distinct structural fingerprints among existing states at this URL
  const structures = new Set(existingSnapshots.map(s => {
    const tags = (s.elements || []).map(el => `${el.tag}:${el.type || ""}`).sort().join(",");
    const components = [
      s.hasModals ? "m" : "", s.hasTabs ? "t" : "", s.hasSidebar ? "s" : "",
      s.hasDropdown ? "d" : "", s.hasToast ? "o" : "", s.hasAccordion ? "a" : "",
    ].filter(Boolean).join("");
    return `${tags}|${components}`;
  }));
  // If every existing state is structurally unique, raise the cap
  if (structures.size >= existingSnapshots.length) {
    return Math.min(existingSnapshots.length + BASE_STATES_PER_URL, MAX_STATES_PER_URL);
  }
  return BASE_STATES_PER_URL;
}

async function captureState(page, ctx) {
  const snapshot = await takeSnapshot(page);
  const fp = fingerprintState(snapshot);
  const isNovel = !ctx.states.has(fp);
  if (isNovel) {
    // Per-URL cap: check against the diversity-aware cap to avoid budget waste
    // on trivially different snapshots while still allowing multi-step wizards
    // and SPA flows to be fully explored (#52 defect #6).
    const existingAtUrl = ctx.snapshots.filter(s => s.url === snapshot.url);
    const cap = effectiveUrlCap(existingAtUrl);
    if (existingAtUrl.length >= cap) {
      return { snapshot, fp, isNovel: false };
    }
    ctx.states.add(fp);
    ctx.snapshotsByFp.set(fp, snapshot);
    ctx.snapshots.push(snapshot);
    // Only store the first snapshot per URL — later states at the same URL
    // (e.g. form blank vs form with errors) are preserved in snapshotsByFp
    // and looked up via _stateFingerprint in journeyPrompt.js.
    if (!ctx.snapshotsByUrl[snapshot.url]) {
      ctx.snapshotsByUrl[snapshot.url] = snapshot;
    }
    // B1.3 (AUDIT-ROADMAP Bundle 1) — stream the novel state to
    // `crawl_snapshots` immediately. Idempotent on (runId, url) — re-
    // entries at the same URL with a different state fingerprint are
    // dropped by the UNIQUE constraint, which is correct for B1.3's
    // "one snapshot per page" contract. B3's per-state persistence would
    // require a richer key (runId, url, stateFp); deferred until then.
    // Best-effort: a persistence hiccup must never fail the explorer.
    //
    // `loadMs` is intentionally not passed: explorer states are captured
    // POST-ACTION (after a click / form fill), not post-navigation, so
    // there's no `page.goto()` wall-clock to record. `takeSnapshot` does
    // not produce a `_loadMs` field, and synthesising one from action
    // timing would mix two different signals (navigation vs interaction)
    // and pollute B2's adaptive-timeout p95 in `crawlSnapshotRepo.
    // getLoadTimesByRunId()`. Only `crawlBrowser.js` records `loadMs`,
    // exclusively around `page.goto()`. Explorer rows therefore store
    // `loadMs: NULL` and are filtered out by B2's percentile query.
    if (ctx.run?.id) {
      try {
        crawlSnapshotRepo.save(ctx.run.id, snapshot.url, snapshot);
      } catch (persistErr) {
        logWarn(ctx.run, `Failed to persist explorer snapshot for ${snapshot.url}: ${persistErr.message}`);
      }
    }
  }
  return { snapshot, fp, isNovel };
}

// Bundle-B fix #18 — throttle DB writes + SSE broadcasts to one per 500ms.
// On novel-state-heavy explorations we were doing dozens of writes per second
// and flooding the SSE channel, starving the UI render loop. The throttle
// state lives on the `run` object so concurrent explorations on different
// runs don't share a window. Force a final flush at end of exploration via
// `forceSyncRunPages`.
const SYNC_RUN_PAGES_THROTTLE_MS = 500;
function syncRunPages(run, snapshots) {
  const now = Date.now();
  if (run.__lastSyncMs && (now - run.__lastSyncMs) < SYNC_RUN_PAGES_THROTTLE_MS) return;
  run.__lastSyncMs = now;
  run.pagesFound = snapshots.length;
  run.pages = snapshots.map(s => ({ url: s.url, title: s.title || s.url, status: "crawled" }));
  // Persist to DB so the site map renders after page reload (not just in-memory)
  runRepo.update(run.id, { pages: run.pages, pagesFound: run.pagesFound });
  // Sign artifact URLs before emitting SSE snapshot (matches testRunner.js pattern)
  emitRunEvent(run.id, "snapshot", { run: signRunArtifacts(run) });
}

function forceSyncRunPages(run, snapshots) {
  // Bundle-B fix #18 — final flush. Bypasses the throttle so the last
  // captured state always reaches the UI even if it landed inside the
  // throttle window.
  run.__lastSyncMs = 0;
  syncRunPages(run, snapshots);
}

// Bundle-B fix #15 — `restorePage` now returns a boolean indicating whether
// the page state was actually restored. Callers break out of their inner
// loop on `false` so the next action doesn't run against an unknown page
// state (which would corrupt the state graph and waste explorer budget).
async function restorePage(page, beforeUrl, fallbackUrl, actionTimeout) {
  try {
    await page.goto(beforeUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await waitForSettle(page, actionTimeout);
    return true;
  } catch {
    try {
      await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await waitForSettle(page, actionTimeout);
      return true;
    } catch {
      return false;
    }
  }
}

function enqueueIfNew(ctx, fp, url, depth) {
  const pathPattern = extractPathPatternWithParams(url);
  if (ctx.pathPatternsSeen.has(pathPattern)) return;
  ctx.pathPatternsSeen.add(pathPattern);
  ctx.queue.push({ fp, url, depth });
}

// Bundle-B fix #16 — per-page link cap. On link-dense pages (e-commerce
// category lists, sitemaps surfaced as anchors) we'd extract 500+ links
// and try to visit each one, blowing the per-run budget on a single page.
const MAX_LINKS_PER_PAGE = 50;

async function crawlLinks(page, currentFp, currentUrl, depth, project, ctx, run, signal) {
  if (depth >= ctx.limits.maxDepth || ctx.states.size >= ctx.limits.maxStates) return;
  let rawLinks;
  try { rawLinks = await page.$$eval("a[href]", els => els.map(e => e.href)); } catch { return; }

  // Bundle-B fix #16 — dedupe by normalised URL + cap to MAX_LINKS_PER_PAGE.
  // Prioritise same-path-prefix links when capping so the explorer doesn't
  // wander off into footer / nav links before exhausting the page's actual
  // content links.
  const currentPathPrefix = (() => {
    try { return new URL(currentUrl).pathname.split("/").slice(0, 2).join("/"); }
    catch { return ""; }
  })();
  const seen = new Set();
  const samePrefix = [];
  const otherLinks = [];
  for (const href of rawLinks) {
    if (typeof href !== "string" || !href) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    let pathname = "";
    try { pathname = new URL(href).pathname; } catch { /* ignore parse error */ }
    if (currentPathPrefix && pathname.startsWith(currentPathPrefix)) {
      samePrefix.push(href);
    } else {
      otherLinks.push(href);
    }
  }
  const links = [...samePrefix, ...otherLinks].slice(0, MAX_LINKS_PER_PAGE);

  for (const href of links) {
    throwIfAborted(signal);
    if (ctx.states.size >= ctx.limits.maxStates) break;
    try {
      const u = new URL(href, currentUrl);
      u.hash = "";
      // Strip only noise query params; preserve significant ones (#52 defect #1).
      stripNoiseParams(u);
      const normalized = u.toString();
      if (!isSameEffectiveOrigin(normalized, ctx.resolvedOrigin || project.url)) continue;
      // robots.txt compliance (#53) — skip disallowed paths
      if (!isAllowed(normalized, ctx.robotsRules)) continue;
      // Use param-aware pattern so /products?category=A and ?category=B
      // are treated as distinct pages (#52 defect #1, Devin review fix).
      const pathPattern = extractPathPatternWithParams(normalized);
      if (ctx.pathPatternsSeen.has(pathPattern)) continue;
      await page.goto(normalized, { waitUntil: "domcontentloaded", timeout: 15000 });
      await waitForSettle(page, ctx.limits.actionTimeout);
      const { fp: linkFp, isNovel } = await captureState(page, ctx);
      // Always mark the path pattern as seen to avoid redundant page loads
      // on subsequent crawlLinks calls, regardless of whether the state is novel.
      ctx.pathPatternsSeen.add(pathPattern);
      if (isNovel && !statesEqual(linkFp, currentFp)) {
        ctx.edges.push({ fromFp: currentFp, action: { type: "click", element: { tag: "a", text: normalized }, selectors: [] }, toFp: linkFp });
        ctx.queue.push({ fp: linkFp, url: normalized, depth: depth + 1 });
        syncRunPages(run, ctx.snapshots);
        log(run, `   🔗 Link: ${normalized} [${linkFp.slice(0, 8)}]`);
      }
      await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await waitForSettle(page, ctx.limits.actionTimeout);
    } catch { /* skip broken links */ }
  }
}

export async function exploreStates(project, run, { signal, tuning } = {}) {
  // Resolve per-run limits from Test Dials tuning, falling back to defaults.
  // Defensive clamping ensures safety even if a caller bypasses route-level
  // validation (testDials.js clampInt). Uses ?? so explicit 0 falls through
  // to the default (0 is never a valid limit).
  function clamp(val, min, max, def) {
    const n = val ?? def;
    return Math.max(min, Math.min(max, Number.isFinite(n) ? n : def));
  }
  const limits = {
    maxStates:     clamp(tuning?.maxStates,     5,   100, DEFAULT_MAX_STATES),
    maxDepth:      clamp(tuning?.maxDepth,       1,   10,  DEFAULT_MAX_DEPTH),
    maxActions:    clamp(tuning?.maxActions,      1,   20,  DEFAULT_MAX_ACTIONS),
    actionTimeout: clamp(tuning?.actionTimeout,  1000, 15000, DEFAULT_ACTION_TIMEOUT),
  };

  // Bundle-B fix #12 — wrap launchBrowser in a structured try so failures
  // surface with run context (project id, tuning) instead of bubbling raw.
  // A raw "Failed to launch browser" error is unattributable in production
  // logs across hundreds of concurrent explorations.
  let browser;
  try {
    browser = await launchBrowser();
  } catch (launchErr) {
    logWarn(run, `launchBrowser failed for project=${project?.id} tuning=${JSON.stringify(tuning || {})}: ${launchErr.message}`);
    throw launchErr;
  }
  // B1.3 (AUDIT-ROADMAP) — `ctx.run` lets `captureState` persist each novel
  // snapshot to `crawl_snapshots` without rippling a new arg through every
  // helper callsite.
  const ctx = { states: new Set(), edges: [], snapshotsByFp: new Map(), snapshots: [], snapshotsByUrl: {}, pathPatternsSeen: new Set(), queue: [], limits, run };
  let startState = null;
  let harCapture = null;

  // Bundle-B fix #14 — absolute 15-minute cap on the global exploration
  // timeout. The previous formula (`maxStates × actionTimeout × 2`) could
  // produce a 50-minute budget at the upper tuning bounds (100 × 15 000 × 2)
  // — long enough that operators forgot exploration was still running and
  // hit upper-tier API rate limits. Capping at 15 minutes matches the
  // documented worst-case in QA.md and surfaces the effective cap in the
  // log line so operators see when their tuning would have exceeded it.
  const GLOBAL_TIMEOUT_HARD_CAP_MS = 15 * 60 * 1000;
  const computedTimeout = limits.maxStates * limits.actionTimeout * 2;
  const GLOBAL_TIMEOUT_MS = Math.min(computedTimeout, GLOBAL_TIMEOUT_HARD_CAP_MS);
  const explorationStart = Date.now();
  function isTimedOut() { return Date.now() - explorationStart > GLOBAL_TIMEOUT_MS; }
  if (computedTimeout > GLOBAL_TIMEOUT_HARD_CAP_MS) {
    log(run, `⏱️ Global timeout capped at ${Math.round(GLOBAL_TIMEOUT_HARD_CAP_MS / 1000)}s (would have been ${Math.round(computedTimeout / 1000)}s from tuning)`);
  }

  try {
    const context = await browser.newContext({ userAgent: "Mozilla/5.0 (compatible; Sentri/1.0)" });

    // Same two-path login as crawlBrowser.js — legacy explicit selectors
    // take priority, falling back to auto-detect when only username +
    // password are persisted.
    const creds = decryptCredentials(project.credentials);
    if (creds?.username && creds?.password) {
      const loginPage = await context.newPage();
      try {
        await loginPage.goto(project.url, { timeout: 15000 });
        if (creds.usernameSelector && creds.passwordSelector && creds.submitSelector) {
          await loginPage.fill(creds.usernameSelector, creds.username);
          await loginPage.fill(creds.passwordSelector, creds.password);
          await loginPage.click(creds.submitSelector);
          // Bundle-B fix #13 — domcontentloaded matches the codebase
          // convention enforced by `feedbackLoop.js#TIMEOUT`; networkidle
          // never resolves on SPAs with continuous background polling.
          await loginPage.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
          log(run, `🔑 Logged in as ${creds.username}`);
        } else {
          const result = await performAutoLogin(loginPage, creds, {
            timeout: 5000,
            logger: (m) => log(run, `   ${m}`),
          });
          if (result.ok) {
            // Bundle-B fix #13 — same domcontentloaded migration as above.
            await loginPage.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
            log(run, `🔑 Auto-logged in as ${creds.username}`);
          } else {
            logWarn(run, `Auto-login failed: ${result.reason}`);
          }
        }
      } catch (e) { logWarn(run, `Login failed: ${e.message}`); }
      finally { await loginPage.close().catch(() => {}); }
    }

    const page = await context.newPage();
    await page.goto(project.url, { waitUntil: "domcontentloaded", timeout: 15000 });

    // Resolve the actual landing URL after redirects (e.g. google.com → www.google.com).
    // All subsequent origin checks use this resolved URL instead of the user-entered one.
    const resolvedUrl = page.url();
    ctx.resolvedOrigin = resolvedUrl;
    if (resolvedUrl !== project.url) {
      log(run, `🔀 Redirected: ${project.url} → ${resolvedUrl}`);
    }

    // ── HAR capture: attach after redirect so it uses the resolved origin ──
    harCapture = createHarCapture(context, resolvedUrl);

    // ── robots.txt + sitemap.xml (#53) ──────────────────────────────────────
    const robotsRules = await loadRobotsRules(resolvedUrl);
    ctx.robotsRules = robotsRules;
    if (robotsRules.rules.length > 0) {
      log(run, `🤖 robots.txt: ${robotsRules.rules.length} rule(s) loaded — restricted paths will be skipped`);
    }
    const sitemapUrls = await loadSitemapUrls(resolvedUrl, robotsRules.sitemaps);
    if (sitemapUrls.length > 0) {
      log(run, `🗺️  sitemap.xml: ${sitemapUrls.length} URL(s) discovered — seeding exploration queue`);
    }

    const { fp: initialFp } = await captureState(page, ctx);
    startState = initialFp;
    ctx.queue.push({ fp: initialFp, url: resolvedUrl, depth: 0 });
    syncRunPages(run, ctx.snapshots);
    log(run, `🔍 Initial state: ${resolvedUrl} [${initialFp.slice(0, 8)}]`);

    // Seed sitemap URLs into the exploration queue (#53)
    if (sitemapUrls.length > 0) {
      for (const smUrl of sitemapUrls) {
        if (isSameEffectiveOrigin(smUrl, resolvedUrl) && isAllowed(smUrl, robotsRules)) {
          enqueueIfNew(ctx, initialFp, smUrl, 1);
        }
      }
    }

    while (ctx.queue.length > 0 && ctx.states.size < limits.maxStates) {
      throwIfAborted(signal);
      if (isTimedOut()) {
        log(run, `⏱️ Global exploration timeout reached (${Math.round(GLOBAL_TIMEOUT_MS / 1000)}s) — stopping`);
        // Bundle-B fix #19 — record global-timeout circuit breaker firing.
        try { explorerGlobalTimeoutTotal.inc(); } catch { /* best-effort */ }
        break;
      }
      const { fp: currentFp, url: currentUrl, depth } = ctx.queue.shift();
      if (depth > limits.maxDepth) continue;
      // Retry transient navigation errors (DNS hiccups, temporary network
      // blips) once before giving up on this state. Without this, a single
      // transient failure would skip the entire state and all its actions.
      let navOk = false;
      for (let navAttempt = 0; navAttempt < 2; navAttempt++) {
        try {
          if (page.url() !== currentUrl) {
            await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
            await waitForSettle(page, limits.actionTimeout);
          }
          navOk = true;
          break;
        } catch (err) {
          if (navAttempt === 0) {
            logWarn(run, `Navigation to ${currentUrl} failed (${err.message}), retrying…`);
            await waitForSettle(page, limits.actionTimeout);
          } else {
            logWarn(run, `Failed to navigate to ${currentUrl} after retry: ${err.message}`);
          }
        }
      }
      if (!navOk) continue;

      // Sitemap-seeded queue items carry the homepage fingerprint as a
      // placeholder because the target page hasn't been visited yet. Detect
      // this by comparing the snapshot URL stored for currentFp with the
      // actual currentUrl. When they differ, capture a fresh state so
      // discoverActions receives the correct page's DOM (#53 bug fix).
      let activeFp = currentFp;
      const storedSnapshot = ctx.snapshotsByFp.get(currentFp);
      if (!storedSnapshot || storedSnapshot.url !== currentUrl) {
        try {
          const { snapshot: freshSnap, fp: freshFp, isNovel } = await captureState(page, ctx);
          activeFp = freshFp;
          // When the per-URL cap is hit, captureState returns isNovel:false
          // without storing the snapshot in snapshotsByFp. Store it so
          // discoverActions and downstream lookups don't receive undefined.
          if (!ctx.snapshotsByFp.has(freshFp)) {
            ctx.snapshotsByFp.set(freshFp, freshSnap);
          }
          if (isNovel && !statesEqual(freshFp, currentFp)) {
            ctx.edges.push({ fromFp: currentFp, action: { type: "click", element: { tag: "a", text: currentUrl }, selectors: [] }, toFp: freshFp });
            syncRunPages(run, ctx.snapshots);
            log(run, `   📸 Captured fresh state for ${currentUrl} [${freshFp.slice(0, 8)}]`);
          }
        } catch (err) {
          logWarn(run, `   Snapshot failed for sitemap URL ${currentUrl}: ${err.message}`);
        }
      }

      const actions = discoverActions(ctx.snapshotsByFp.get(activeFp));
      const { formGroups, standalone } = groupActionsByForm(actions);
      log(run, `🎯 [${activeFp.slice(0, 8)}] depth=${depth}: ${actions.length} actions (${formGroups.size} forms)`);

      for (const [formId, formActions] of formGroups) {
        throwIfAborted(signal);
        if (ctx.states.size >= limits.maxStates) break;
        const beforeUrl = page.url();
        log(run, `   📝 Form "${formId}" (${formActions.length} fields)...`);

        // S3-08: If the form looks like a signup/registration requiring email
        // verification, delegate to the DisposableEmail flow instead of the
        // standard form filler. This lets Sentri complete flows that would
        // otherwise be blocked by an email verification step.
        let executedActions = [];
        // Bundle-B fix #20 — track mailbox-flow vs standard-flow executed
        // actions separately so a signup-flow throw partway through fills
        // doesn't drop the mailbox-flow fills from the audit trail when we
        // fall back to standard. Pre-fix the reassignment to
        // `executedActions = await executeFormGroup(...)` in the catch arm
        // wiped everything the mailbox flow had completed.
        let mailboxFlowExecutedActions = [];
        let standardFlowExecutedActions = [];
        const currentSnapshot = ctx.snapshotsByFp.get(activeFp);
        if (detectSignupIntent(currentSnapshot, formActions)) {
          log(run, `   📧 Signup form detected — using disposable email flow`);
          let mailbox = null;
          try {
            // Build field descriptors for the helper from the form's fill actions
            const fields = formActions
              .filter(a => a.type === "fill")
              .map(a => ({
                selector:    a.selectors[0] || "",
                type:        a.element?.type || "",
                label:       a.element?.label || "",
                placeholder: a.element?.placeholder || "",
                ariaLabel:   a.element?.ariaLabel || "",
              }));

            // Step 1: Fill all form fields (email + password + others)
            const result = await fillEmailVerificationFlow(page, fields, run);
            mailbox = result.mailbox;
            if (result.email) {
              log(run, `   ✉️  Disposable email used: ${result.email}`);
            }
            // Track fill actions as executed against the mailbox-flow bucket.
            mailboxFlowExecutedActions.push(...formActions.filter(a => a.type === "fill"));

            // Step 2: Submit the form FIRST (verification email is sent after submit)
            const submitActions = formActions.filter(a => a.type === "submit" || a.type === "click");
            for (const act of submitActions) {
              try { explorerActionsAttemptedTotal.inc({ type: act.type }); } catch { /* best-effort */ }
              if (await executeAction(page, act, limits.actionTimeout)) {
                mailboxFlowExecutedActions.push(act);
              }
            }
            await waitForSettle(page, limits.actionTimeout);

            // Step 3: Now poll for OTP / verification link (after form is submitted)
            const { otpFilled, linkFollowed } = await waitForVerification(page, mailbox);
            if (otpFilled || linkFollowed) {
              log(run, `   ✅ Verification completed (otp=${otpFilled}, link=${linkFollowed})`);
            }
          } catch (emailErr) {
            log(run, `   ⚠️  Disposable email flow failed: ${emailErr.message} — falling back to standard fill`);
            // Bundle-B fix #20 — fall through to standard form execution,
            // but PRESERVE the mailbox-flow partial-action audit by writing
            // standard-flow actions into a separate bucket and concatenating
            // both into `executedActions` after the if/else block.
            standardFlowExecutedActions = await executeFormGroup(page, formActions, limits.actionTimeout);
            await waitForSettle(page, limits.actionTimeout);
          } finally {
            if (mailbox) await dispose(mailbox).catch(() => {});
          }
        } else {
          standardFlowExecutedActions = await executeFormGroup(page, formActions, limits.actionTimeout);
          await waitForSettle(page, limits.actionTimeout);
        }
        // Bundle-B fix #20 — concatenate so a partial-mailbox flow retains
        // its fills even after fallback to standard.
        executedActions = [...mailboxFlowExecutedActions, ...standardFlowExecutedActions];

        // Always attempt to capture state after the form interaction,
        // regardless of which code path above was taken.
        if (executedActions.length > 0) {
          // Guard: reject cross-origin navigation or bot detection pages
          if (!isSameOriginAndValid(page.url(), ctx.resolvedOrigin)) {
            log(run, `   ⏭️  Form navigated off-origin → ${page.url()} — restoring`);
            // Bundle-B fix #19 — bot/off-origin counter.
            try { explorerBotBlockSkipsTotal.inc(); } catch { /* best-effort */ }
            // Bundle-B fix #15 — break out of the inner form loop when the
            // page state could not be restored. Continuing would corrupt
            // the state graph with edges from an unknown page.
            if (!await restorePage(page, beforeUrl, currentUrl, limits.actionTimeout)) break;
            continue;
          }
          try {
            const { fp: resultFp, isNovel } = await captureState(page, ctx);
            if (!statesEqual(resultFp, activeFp)) {
              // Record an edge only for actions that were actually executed
              for (const act of executedActions) ctx.edges.push({ fromFp: activeFp, action: act, toFp: resultFp });
              if (isNovel) {
                enqueueIfNew(ctx, resultFp, ctx.snapshotsByFp.get(resultFp).url, depth + 1);
                syncRunPages(run, ctx.snapshots);
                // Bundle-B fix #19 — state-discovery counter.
                try { explorerStatesDiscoveredTotal.inc(); } catch { /* best-effort */ }
                log(run, `   ✨ New state: ${ctx.snapshotsByFp.get(resultFp).url} [${resultFp.slice(0, 8)}]`);
              }
            }
          } catch (err) { logWarn(run, `   Snapshot failed after form: ${err.message}`); }
        }
        // Bundle-B fix #15 — same break-on-restore-fail rule for the
        // success path so a failed post-form goto can't poison the next
        // iteration's beforeUrl baseline.
        if (!await restorePage(page, beforeUrl, currentUrl, limits.actionTimeout)) break;
      }

      let explored = 0;
      for (const action of standalone) {
        throwIfAborted(signal);
        if (ctx.states.size >= limits.maxStates || explored >= limits.maxActions) break;
        if (action.isDestructive) { log(run, `   ⏭️  Skip destructive: "${action.element.text}"`); continue; }
        const beforeUrl = page.url();
        // Bundle-B fix #19 — actions-attempted counter (split by action type).
        try { explorerActionsAttemptedTotal.inc({ type: action.type }); } catch { /* best-effort */ }
        if (!await executeAction(page, action, limits.actionTimeout)) continue;
        await waitForSettle(page, limits.actionTimeout);
        // Guard: reject cross-origin navigation or bot detection pages
        if (!isSameOriginAndValid(page.url(), ctx.resolvedOrigin)) {
          log(run, `   ⏭️  Action navigated off-origin → ${page.url()} — restoring`);
          // Bundle-B fix #19 — bot-block / off-origin counter.
          try { explorerBotBlockSkipsTotal.inc(); } catch { /* best-effort */ }
          // Bundle-B fix #15 — break out of the standalone loop on restore
          // failure (same rationale as the form loop above).
          if (!await restorePage(page, beforeUrl, currentUrl, limits.actionTimeout)) break;
          continue;
        }
        explored++;
        try {
          const { fp: resultFp, isNovel } = await captureState(page, ctx);
          if (!statesEqual(resultFp, activeFp)) {
            ctx.edges.push({ fromFp: activeFp, action, toFp: resultFp });
            if (isNovel) {
              enqueueIfNew(ctx, resultFp, ctx.snapshotsByFp.get(resultFp).url, depth + 1);
              syncRunPages(run, ctx.snapshots);
              try { explorerStatesDiscoveredTotal.inc(); } catch { /* best-effort */ }
              log(run, `   ✨ New state: ${ctx.snapshotsByFp.get(resultFp).url} [${resultFp.slice(0, 8)}]`);
            }
          }
        } catch (err) { logWarn(run, `   Snapshot failed after action: ${err.message}`); }
        if (!await restorePage(page, beforeUrl, currentUrl, limits.actionTimeout)) break;
      }

      await crawlLinks(page, activeFp, currentUrl, depth, project, ctx, run, signal);
    }
    await page.close().catch(() => {});

    // Detach HAR capture before browser.close() so listeners complete cleanly
    if (harCapture) harCapture.detach();
  } finally {
    await browser.close().catch(() => {});
    // Bundle-B fix #18 — force a final sync so the last captured state
    // always reaches the UI even if it landed inside the 500ms throttle
    // window. No-op when nothing new was captured.
    try { forceSyncRunPages(run, ctx.snapshots); } catch { /* best-effort */ }
    // Bundle-B fix #19 — exploration-duration histogram.
    try { explorerDurationSeconds.observe((Date.now() - explorationStart) / 1000); } catch { /* best-effort */ }
  }

  // ── Summarise captured API traffic ────────────────────────────────────────
  let apiEndpoints = [];
  if (harCapture) {
    apiEndpoints = summariseApiEndpoints(harCapture.getEntries());
    if (apiEndpoints.length > 0) {
      log(run, `🌐 Captured ${harCapture.getEntries().length} API calls → ${apiEndpoints.length} unique endpoint patterns`);
    }
  }

  const stateGraph = { states: ctx.states, edges: ctx.edges, startState, snapshotsByFp: ctx.snapshotsByFp };
  const flows = extractFlows(stateGraph);
  const journeys = flows.map(f => flowToJourney(f, ctx.snapshotsByFp));
  logSuccess(run, `State exploration done. ${ctx.states.size} states, ${ctx.edges.length} transitions, ${flows.length} flows.`);

  return { snapshots: ctx.snapshots, snapshotsByUrl: ctx.snapshotsByUrl, stateGraph, flows, journeys, apiEndpoints };
}
