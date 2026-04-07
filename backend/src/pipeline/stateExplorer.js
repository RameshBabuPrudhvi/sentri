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

import { chromium } from "playwright";
import { throwIfAborted } from "../utils/abortHelper.js";
import { takeSnapshot } from "./pageSnapshot.js";
import { fingerprintState, statesEqual } from "./stateFingerprint.js";
import { discoverActions } from "./actionDiscovery.js";
import { extractFlows, flowToJourney } from "./flowGraph.js";
import { extractPathPattern } from "./smartCrawl.js";
import { log, logWarn, logSuccess } from "../utils/runLogger.js";
import { decryptCredentials } from "../utils/credentialEncryption.js";
import { createHarCapture, summariseApiEndpoints } from "./harCapture.js";

// Defaults — overridden per-run by tuning values from Test Dials
const DEFAULT_MAX_STATES = parseInt(process.env.CRAWL_MAX_PAGES, 10) || 30;
const DEFAULT_MAX_DEPTH  = parseInt(process.env.CRAWL_MAX_DEPTH, 10) || 3;
const DEFAULT_MAX_ACTIONS = 8;
const DEFAULT_ACTION_TIMEOUT = 5000;

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
        if (action.value) { await el.fill(""); await el.fill(action.value); } else { return false; } break;
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

async function captureState(page, ctx) {
  const snapshot = await takeSnapshot(page);
  const fp = fingerprintState(snapshot);
  const isNovel = !ctx.states.has(fp);
  if (isNovel) {
    ctx.states.add(fp);
    ctx.snapshotsByFp.set(fp, snapshot);
    ctx.snapshots.push(snapshot);
    // Only store the first snapshot per URL — later states at the same URL
    // (e.g. form blank vs form with errors) are preserved in snapshotsByFp
    // and looked up via _stateFingerprint in journeyPrompt.js.
    if (!ctx.snapshotsByUrl[snapshot.url]) {
      ctx.snapshotsByUrl[snapshot.url] = snapshot;
    }
  }
  return { snapshot, fp, isNovel };
}

function syncRunPages(run, snapshots) {
  run.pagesFound = snapshots.length;
  run.pages = snapshots.map(s => ({ url: s.url, title: s.title || s.url, status: "crawled" }));
}

async function restorePage(page, beforeUrl, fallbackUrl, actionTimeout) {
  try {
    await page.goto(beforeUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await waitForSettle(page, actionTimeout);
  } catch {
    await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  }
}

function enqueueIfNew(ctx, fp, url, depth) {
  const pathPattern = extractPathPattern(url);
  if (ctx.pathPatternsSeen.has(pathPattern)) return;
  ctx.pathPatternsSeen.add(pathPattern);
  ctx.queue.push({ fp, url, depth });
}

async function crawlLinks(page, currentFp, currentUrl, depth, project, ctx, run, signal) {
  if (depth >= ctx.limits.maxDepth || ctx.states.size >= ctx.limits.maxStates) return;
  let links;
  try { links = await page.$$eval("a[href]", els => els.map(e => e.href)); } catch { return; }
  for (const href of links) {
    throwIfAborted(signal);
    if (ctx.states.size >= ctx.limits.maxStates) break;
    try {
      const u = new URL(href, currentUrl);
      u.hash = ""; u.search = "";
      const normalized = u.toString();
      if (new URL(normalized).origin !== new URL(project.url).origin) continue;
      const pathPattern = extractPathPattern(normalized);
      if (ctx.pathPatternsSeen.has(pathPattern)) continue;
      await page.goto(normalized, { waitUntil: "domcontentloaded", timeout: 15000 });
      await waitForSettle(page, ctx.limits.actionTimeout);
      const { fp: linkFp, isNovel } = await captureState(page, ctx);
      if (isNovel && !statesEqual(linkFp, currentFp)) {
        ctx.pathPatternsSeen.add(pathPattern);
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
  // Resolve per-run limits from Test Dials tuning, falling back to defaults
  const limits = {
    maxStates:     tuning?.maxStates     ?? DEFAULT_MAX_STATES,
    maxDepth:      tuning?.maxDepth      ?? DEFAULT_MAX_DEPTH,
    maxActions:    tuning?.maxActions     ?? DEFAULT_MAX_ACTIONS,
    actionTimeout: tuning?.actionTimeout ?? DEFAULT_ACTION_TIMEOUT,
  };

  const browser = await chromium.launch({
    headless: process.env.BROWSER_HEADLESS !== "false",
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = { states: new Set(), edges: [], snapshotsByFp: new Map(), snapshots: [], snapshotsByUrl: {}, pathPatternsSeen: new Set(), queue: [], limits };
  let startState = null;

  try {
    const context = await browser.newContext({ userAgent: "Mozilla/5.0 (compatible; Sentri/1.0)" });

    // ── HAR capture: record API traffic for API test generation ────────────
    const harCapture = createHarCapture(context, project.url);

    const creds = decryptCredentials(project.credentials);
    if (creds?.usernameSelector) {
      const loginPage = await context.newPage();
      try {
        await loginPage.goto(project.url, { timeout: 15000 });
        await loginPage.fill(creds.usernameSelector, creds.username);
        await loginPage.fill(creds.passwordSelector, creds.password);
        await loginPage.click(creds.submitSelector);
        await loginPage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        log(run, `🔑 Logged in as ${creds.username}`);
      } catch (e) { logWarn(run, `Login failed: ${e.message}`); }
      finally { await loginPage.close().catch(() => {}); }
    }

    const page = await context.newPage();
    await page.goto(project.url, { waitUntil: "domcontentloaded", timeout: 15000 });
    const { fp: initialFp } = await captureState(page, ctx);
    startState = initialFp;
    ctx.queue.push({ fp: initialFp, url: project.url, depth: 0 });
    syncRunPages(run, ctx.snapshots);
    log(run, `🔍 Initial state: ${project.url} [${initialFp.slice(0, 8)}]`);

    while (ctx.queue.length > 0 && ctx.states.size < limits.maxStates) {
      throwIfAborted(signal);
      const { fp: currentFp, url: currentUrl, depth } = ctx.queue.shift();
      if (depth > limits.maxDepth) continue;
      try {
        if (page.url() !== currentUrl) { await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 15000 }); await waitForSettle(page, limits.actionTimeout); }
      } catch (err) { logWarn(run, `Failed to navigate to ${currentUrl}: ${err.message}`); continue; }

      const actions = discoverActions(ctx.snapshotsByFp.get(currentFp));
      const { formGroups, standalone } = groupActionsByForm(actions);
      log(run, `🎯 [${currentFp.slice(0, 8)}] depth=${depth}: ${actions.length} actions (${formGroups.size} forms)`);

      for (const [formId, formActions] of formGroups) {
        throwIfAborted(signal);
        if (ctx.states.size >= limits.maxStates) break;
        const beforeUrl = page.url();
        log(run, `   📝 Form "${formId}" (${formActions.length} fields)...`);
        const executed = await executeFormGroup(page, formActions, limits.actionTimeout);
        await waitForSettle(page, limits.actionTimeout);
        if (executed.length > 0) {
          try {
            const { fp: resultFp, isNovel } = await captureState(page, ctx);
            if (!statesEqual(resultFp, currentFp)) {
              for (const act of executed) ctx.edges.push({ fromFp: currentFp, action: act, toFp: resultFp });
              if (isNovel) { enqueueIfNew(ctx, resultFp, ctx.snapshotsByFp.get(resultFp).url, depth + 1); syncRunPages(run, ctx.snapshots); log(run, `   ✨ New state: ${ctx.snapshotsByFp.get(resultFp).url} [${resultFp.slice(0, 8)}]`); }
            }
          } catch (err) { logWarn(run, `   Snapshot failed after form: ${err.message}`); }
        }
        await restorePage(page, beforeUrl, currentUrl, limits.actionTimeout);
      }

      let explored = 0;
      for (const action of standalone) {
        throwIfAborted(signal);
        if (ctx.states.size >= limits.maxStates || explored >= limits.maxActions) break;
        if (action.isDestructive) { log(run, `   ⏭️  Skip destructive: "${action.element.text}"`); continue; }
        const beforeUrl = page.url();
        if (!await executeAction(page, action, limits.actionTimeout)) continue;
        explored++;
        await waitForSettle(page, limits.actionTimeout);
        try {
          const { fp: resultFp, isNovel } = await captureState(page, ctx);
          if (!statesEqual(resultFp, currentFp)) {
            ctx.edges.push({ fromFp: currentFp, action, toFp: resultFp });
            if (isNovel) { enqueueIfNew(ctx, resultFp, ctx.snapshotsByFp.get(resultFp).url, depth + 1); syncRunPages(run, ctx.snapshots); log(run, `   ✨ New state: ${ctx.snapshotsByFp.get(resultFp).url} [${resultFp.slice(0, 8)}]`); }
          }
        } catch (err) { logWarn(run, `   Snapshot failed after action: ${err.message}`); }
        await restorePage(page, beforeUrl, currentUrl, limits.actionTimeout);
      }

      await crawlLinks(page, currentFp, currentUrl, depth, project, ctx, run, signal);
    }
    await page.close().catch(() => {});
  } finally { await browser.close().catch(() => {}); }

  // ── Summarise captured API traffic ────────────────────────────────────────
  harCapture.detach();
  const apiEndpoints = summariseApiEndpoints(harCapture.getEntries());
  if (apiEndpoints.length > 0) {
    log(run, `🌐 Captured ${harCapture.getEntries().length} API calls → ${apiEndpoints.length} unique endpoint patterns`);
  }

  const stateGraph = { states: ctx.states, edges: ctx.edges, startState, snapshotsByFp: ctx.snapshotsByFp };
  const flows = extractFlows(stateGraph);
  const journeys = flows.map(f => flowToJourney(f, ctx.snapshotsByFp));
  logSuccess(run, `State exploration done. ${ctx.states.size} states, ${ctx.edges.length} transitions, ${flows.length} flows.`);

  return { snapshots: ctx.snapshots, snapshotsByUrl: ctx.snapshotsByUrl, stateGraph, flows, journeys, apiEndpoints };
}
