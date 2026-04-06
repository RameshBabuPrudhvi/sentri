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

const MAX_STATES = parseInt(process.env.EXPLORE_MAX_STATES, 10)
  || parseInt(process.env.CRAWL_MAX_PAGES, 10) || 30;
const MAX_DEPTH = parseInt(process.env.EXPLORE_MAX_DEPTH, 10)
  || parseInt(process.env.CRAWL_MAX_DEPTH, 10) || 3;
const MAX_ACTIONS_PER_STATE = parseInt(process.env.EXPLORE_MAX_ACTIONS, 10) || 8;
const ACTION_TIMEOUT = parseInt(process.env.EXPLORE_ACTION_TIMEOUT, 10) || 5000;

async function resolveElement(page, selectors, timeout = ACTION_TIMEOUT) {
  for (const sel of selectors) {
    try {
      const locator = page.locator(sel).first();
      await locator.waitFor({ state: "visible", timeout });
      return locator;
    } catch { /* next strategy */ }
  }
  return null;
}

async function executeAction(page, action) {
  const el = await resolveElement(page, action.selectors);
  if (!el) return false;
  try {
    switch (action.type) {
      case "click": case "submit":
        await el.click({ timeout: ACTION_TIMEOUT }); break;
      case "fill":
        if (action.value) { await el.fill(""); await el.fill(action.value); } break;
      case "select":
        await el.selectOption({ index: 1 }).catch(() => {}); break;
      case "check":
        await el.check({ timeout: ACTION_TIMEOUT }).catch(() =>
          el.click({ timeout: ACTION_TIMEOUT })
        ); break;
      default: return false;
    }
    return true;
  } catch { return false; }
}

async function waitForSettle(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT }).catch(() => {});
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

async function executeFormGroup(page, formActions) {
  const executed = [];
  const typeOrder = { fill: 0, check: 1, select: 1, submit: 2, click: 2 };
  const sorted = [...formActions].sort((a, b) => (typeOrder[a.type] || 3) - (typeOrder[b.type] || 3));
  for (const action of sorted) {
    if (await executeAction(page, action)) executed.push(action);
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
    ctx.snapshotsByUrl[snapshot.url] = snapshot;
  }
  return { snapshot, fp, isNovel };
}

function syncRunPages(run, snapshots) {
  run.pagesFound = snapshots.length;
  run.pages = snapshots.map(s => ({ url: s.url, title: s.title || s.url, status: "crawled" }));
}

async function restorePage(page, beforeUrl, fallbackUrl) {
  try {
    await page.goto(beforeUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await waitForSettle(page);
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
  if (depth >= MAX_DEPTH || ctx.states.size >= MAX_STATES) return;
  let links;
  try { links = await page.$$eval("a[href]", els => els.map(e => e.href)); } catch { return; }
  for (const href of links) {
    throwIfAborted(signal);
    if (ctx.states.size >= MAX_STATES) break;
    try {
      const u = new URL(href, currentUrl);
      u.hash = ""; u.search = "";
      const normalized = u.toString();
      if (new URL(normalized).origin !== new URL(project.url).origin) continue;
      const pathPattern = extractPathPattern(normalized);
      if (ctx.pathPatternsSeen.has(pathPattern)) continue;
      await page.goto(normalized, { waitUntil: "domcontentloaded", timeout: 15000 });
      await waitForSettle(page);
      const { fp: linkFp, isNovel } = await captureState(page, ctx);
      if (isNovel && !statesEqual(linkFp, currentFp)) {
        ctx.pathPatternsSeen.add(pathPattern);
        ctx.edges.push({ fromFp: currentFp, action: { type: "click", element: { tag: "a", text: normalized }, selectors: [] }, toFp: linkFp });
        ctx.queue.push({ fp: linkFp, url: normalized, depth: depth + 1 });
        syncRunPages(run, ctx.snapshots);
        log(run, `   🔗 Link: ${normalized} [${linkFp.slice(0, 8)}]`);
      }
      await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await waitForSettle(page);
    } catch { /* skip broken links */ }
  }
}

export async function exploreStates(project, run, { signal } = {}) {
  const browser = await chromium.launch({
    headless: process.env.BROWSER_HEADLESS !== "false",
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = { states: new Set(), edges: [], snapshotsByFp: new Map(), snapshots: [], snapshotsByUrl: {}, pathPatternsSeen: new Set(), queue: [] };
  let startState = null;

  try {
    const context = await browser.newContext({ userAgent: "Mozilla/5.0 (compatible; Sentri/1.0)" });

    if (project.credentials?.usernameSelector) {
      const loginPage = await context.newPage();
      try {
        await loginPage.goto(project.url, { timeout: 15000 });
        await loginPage.fill(project.credentials.usernameSelector, project.credentials.username);
        await loginPage.fill(project.credentials.passwordSelector, project.credentials.password);
        await loginPage.click(project.credentials.submitSelector);
        await loginPage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        log(run, `🔑 Logged in as ${project.credentials.username}`);
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

    while (ctx.queue.length > 0 && ctx.states.size < MAX_STATES) {
      throwIfAborted(signal);
      const { fp: currentFp, url: currentUrl, depth } = ctx.queue.shift();
      if (depth > MAX_DEPTH) continue;
      try {
        if (page.url() !== currentUrl) { await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 15000 }); await waitForSettle(page); }
      } catch (err) { logWarn(run, `Failed to navigate to ${currentUrl}: ${err.message}`); continue; }

      const actions = discoverActions(ctx.snapshotsByFp.get(currentFp));
      const { formGroups, standalone } = groupActionsByForm(actions);
      log(run, `🎯 [${currentFp.slice(0, 8)}] depth=${depth}: ${actions.length} actions (${formGroups.size} forms)`);

      for (const [formId, formActions] of formGroups) {
        throwIfAborted(signal);
        if (ctx.states.size >= MAX_STATES) break;
        const beforeUrl = page.url();
        log(run, `   📝 Form "${formId}" (${formActions.length} fields)...`);
        const executed = await executeFormGroup(page, formActions);
        await waitForSettle(page);
        if (executed.length > 0) {
          try {
            const { fp: resultFp, isNovel } = await captureState(page, ctx);
            if (!statesEqual(resultFp, currentFp)) {
              for (const act of executed) ctx.edges.push({ fromFp: currentFp, action: act, toFp: resultFp });
              if (isNovel) { enqueueIfNew(ctx, resultFp, ctx.snapshotsByFp.get(resultFp).url, depth + 1); syncRunPages(run, ctx.snapshots); log(run, `   ✨ New state: ${ctx.snapshotsByFp.get(resultFp).url} [${resultFp.slice(0, 8)}]`); }
            }
          } catch (err) { logWarn(run, `   Snapshot failed after form: ${err.message}`); }
        }
        await restorePage(page, beforeUrl, currentUrl);
      }

      let explored = 0;
      for (const action of standalone) {
        throwIfAborted(signal);
        if (ctx.states.size >= MAX_STATES || explored >= MAX_ACTIONS_PER_STATE) break;
        if (action.isDestructive) { log(run, `   ⏭️  Skip destructive: "${action.element.text}"`); continue; }
        const beforeUrl = page.url();
        if (!await executeAction(page, action)) continue;
        explored++;
        await waitForSettle(page);
        try {
          const { fp: resultFp, isNovel } = await captureState(page, ctx);
          if (!statesEqual(resultFp, currentFp)) {
            ctx.edges.push({ fromFp: currentFp, action, toFp: resultFp });
            if (isNovel) { enqueueIfNew(ctx, resultFp, ctx.snapshotsByFp.get(resultFp).url, depth + 1); syncRunPages(run, ctx.snapshots); log(run, `   ✨ New state: ${ctx.snapshotsByFp.get(resultFp).url} [${resultFp.slice(0, 8)}]`); }
          }
        } catch (err) { logWarn(run, `   Snapshot failed after action: ${err.message}`); }
        await restorePage(page, beforeUrl, currentUrl);
      }

      await crawlLinks(page, currentFp, currentUrl, depth, project, ctx, run, signal);
    }
    await page.close().catch(() => {});
  } finally { await browser.close().catch(() => {}); }

  const stateGraph = { states: ctx.states, edges: ctx.edges, startState, snapshotsByFp: ctx.snapshotsByFp };
  const flows = extractFlows(stateGraph);
  const journeys = flows.map(f => flowToJourney(f, ctx.snapshotsByFp));
  logSuccess(run, `State exploration done. ${ctx.states.size} states, ${ctx.edges.length} transitions, ${flows.length} flows.`);

  return { snapshots: ctx.snapshots, snapshotsByUrl: ctx.snapshotsByUrl, stateGraph, flows, journeys };
}
