/**
 * @module tests/bundle-b-state-explorer
 * @description Bundle-B fixes #12-#20 — state-explorer reliability pins.
 *
 * Pinned via source-grep + behavioural sub-models because exercising the
 * real explorer requires a Playwright browser + a target site (covered by
 * the Golden E2E re-run). Each test cites the spec line so a regression
 * points straight at `docs/roadmap/Bugs.md`.
 */
import assert from "node:assert/strict";
import fs from "fs";

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✅  ${name}`))
    .catch((err) => {
      console.log(`  ❌  ${name}`);
      console.log(`      ${err.stack || err.message || err}`);
      process.exitCode = 1;
    });
}

console.log("\n🕸  Bundle-B state-explorer pins (fixes #12–#20)");

const stateExplorerSrc = fs.readFileSync(
  new URL("../src/pipeline/stateExplorer.js", import.meta.url),
  "utf8",
);

// ── Fix #12: launchBrowser wrapped in structured try ────────────────────────
await test("#12 launchBrowser failure produces structured logWarn before rethrow", () => {
  assert.match(stateExplorerSrc, /launchBrowser failed for project=\$\{project\?\.id\}/);
  assert.match(stateExplorerSrc, /catch \(launchErr\)[\s\S]{0,300}throw launchErr/);
});

// ── Fix #13: state-explorer login → domcontentloaded ────────────────────────
await test("#13 login waitForLoadState uses domcontentloaded (not networkidle)", () => {
  // Locate the login block bounded by the credentials guard and the
  // matching close brace.
  const loginIdx = stateExplorerSrc.indexOf("if (creds?.username && creds?.password) {");
  assert.ok(loginIdx > 0);
  // Find the closing brace of the login if-block. The next reliable
  // marker after both waitForLoadState calls is `await page.goto(project.url`.
  const loginEnd = stateExplorerSrc.indexOf("const page = await context.newPage();", loginIdx);
  assert.ok(loginEnd > loginIdx);
  const loginBlock = stateExplorerSrc.slice(loginIdx, loginEnd);
  // Both networkidle calls must have been migrated to domcontentloaded.
  assert.ok(!loginBlock.includes('"networkidle"'),
    "login block must not call waitForLoadState(networkidle, ...)");
  // At least two domcontentloaded calls (one explicit, one auto-login).
  const matches = loginBlock.match(/waitForLoadState\("domcontentloaded"/g) || [];
  assert.ok(matches.length >= 2,
    `expected ≥ 2 domcontentloaded calls in the login block, got ${matches.length}`);
});

// ── Fix #14: GLOBAL_TIMEOUT capped at 15 minutes ────────────────────────────
await test("#14 GLOBAL_TIMEOUT capped at 15 minutes regardless of tuning", () => {
  assert.match(stateExplorerSrc, /const GLOBAL_TIMEOUT_HARD_CAP_MS = 15 \* 60 \* 1000/);
  assert.match(
    stateExplorerSrc,
    /Math\.min\(computedTimeout, GLOBAL_TIMEOUT_HARD_CAP_MS\)/,
  );
  // Pin the math: maxStates=100, actionTimeout=15000 must yield 15-min cap.
  const computed = (maxStates, actionTimeout) =>
    Math.min(maxStates * actionTimeout * 2, 15 * 60 * 1000);
  assert.equal(computed(100, 15000), 15 * 60 * 1000);
  assert.equal(computed(5, 1000), 10000);
});

// ── Fix #15: restorePage returns boolean ────────────────────────────────────
await test("#15 restorePage returns true on success / false on both-fails", () => {
  // Source-grep that the function returns booleans on every branch.
  assert.match(stateExplorerSrc, /async function restorePage[\s\S]{0,400}return true/);
  assert.match(stateExplorerSrc, /return false/);
  // Pin caller behaviour: form + standalone + bot-block branches all
  // break out of their inner loop on `false`.
  const breakOnFalseRe = /if \(!await restorePage\(page, beforeUrl, currentUrl, limits\.actionTimeout\)\) break/g;
  const matches = stateExplorerSrc.match(breakOnFalseRe) || [];
  assert.ok(matches.length >= 4,
    `expected ≥ 4 break-on-false call sites (form ok, form bot-block, standalone ok, standalone bot-block), got ${matches.length}`);
});

// ── Fix #16: crawlLinks dedupes + caps to 50 per page ────────────────────────
await test("#16 link extraction dedupes + caps at 50 unique URLs per page", () => {
  assert.match(stateExplorerSrc, /const MAX_LINKS_PER_PAGE = 50/);
  // Behavioural model of the same prefix-prioritise + cap logic.
  const MAX = 50;
  const raw = [];
  for (let i = 0; i < 500; i++) raw.push(`https://x.test/item/${i}`);
  // Dedup (already unique) + cap.
  const seen = new Set();
  const out = [];
  for (const href of raw) {
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
    if (out.length >= MAX) break;
  }
  assert.equal(out.length, MAX);
});

// ── Fix #17: stateExplorer fill drops redundant el.fill("") ─────────────────
await test("#17 executeAction fill no longer calls el.fill('') before fill(value)", () => {
  assert.doesNotMatch(
    stateExplorerSrc,
    /await el\.fill\(""\);\s*await el\.fill\(action\.value\)/,
    "redundant fill('') must be gone",
  );
  // Direct fill(value) call still present.
  assert.match(stateExplorerSrc, /await el\.fill\(action\.value\)/);
});

// ── Fix #18: syncRunPages throttled to 500ms ────────────────────────────────
await test("#18 syncRunPages throttled to one call per 500ms with final flush", () => {
  assert.match(stateExplorerSrc, /const SYNC_RUN_PAGES_THROTTLE_MS = 500/);
  assert.match(
    stateExplorerSrc,
    /if \(run\.__lastSyncMs && \(now - run\.__lastSyncMs\) < SYNC_RUN_PAGES_THROTTLE_MS\) return/,
  );
  assert.match(stateExplorerSrc, /function forceSyncRunPages\(run, snapshots\)/);
  // Behavioural model: 30 calls within 1500ms collapse to ≤ 4.
  let writes = 0;
  const run = {};
  const THROTTLE = 500;
  function sync(now) {
    if (run.__lastSyncMs && (now - run.__lastSyncMs) < THROTTLE) return;
    run.__lastSyncMs = now;
    writes++;
  }
  // 30 calls evenly spread over 1500ms (50ms apart).
  for (let i = 0; i < 30; i++) sync(i * 50);
  assert.ok(writes <= 4, `expected ≤ 4 writes across 1500ms, got ${writes}`);
});

// ── Fix #19: explorer metrics registered + bumped ───────────────────────────
await test("#19 explorer metrics registered with correct names", async () => {
  const metrics = await import("../src/utils/metrics.js");
  for (const name of [
    "explorerStatesDiscoveredTotal",
    "explorerActionsAttemptedTotal",
    "explorerBotBlockSkipsTotal",
    "explorerGlobalTimeoutTotal",
    "explorerDurationSeconds",
  ]) {
    assert.ok(metrics[name], `${name} must be exported from utils/metrics.js`);
  }
  // Behavioural pin: each export points at the documented Prometheus name.
  const states = await metrics.explorerStatesDiscoveredTotal.get();
  assert.equal(states.name, "app_explorer_states_discovered_total");
  const actions = await metrics.explorerActionsAttemptedTotal.get();
  assert.equal(actions.name, "app_explorer_actions_attempted_total");
  const skips = await metrics.explorerBotBlockSkipsTotal.get();
  assert.equal(skips.name, "app_explorer_bot_block_skips_total");
  const timeouts = await metrics.explorerGlobalTimeoutTotal.get();
  assert.equal(timeouts.name, "app_explorer_global_timeout_total");
  const duration = await metrics.explorerDurationSeconds.get();
  assert.equal(duration.name, "app_explorer_duration_seconds");
  // All five increment sites exist in stateExplorer.js.
  const incRe = /explorer(?:StatesDiscoveredTotal|ActionsAttemptedTotal|BotBlockSkipsTotal|GlobalTimeoutTotal)\.inc/g;
  const incMatches = stateExplorerSrc.match(incRe) || [];
  assert.ok(incMatches.length >= 5,
    `expected ≥ 5 explorer-metric .inc() call sites, got ${incMatches.length}`);
  assert.match(stateExplorerSrc, /explorerDurationSeconds\.observe/);
});

// ── Fix #20: detectSignupIntent preserves partial-action audit ──────────────
await test("#20 mailbox flow + standard flow audits concatenated, never overwritten", () => {
  assert.match(stateExplorerSrc, /let mailboxFlowExecutedActions = \[\]/);
  assert.match(stateExplorerSrc, /let standardFlowExecutedActions = \[\]/);
  assert.match(
    stateExplorerSrc,
    /executedActions = \[\.\.\.mailboxFlowExecutedActions, \.\.\.standardFlowExecutedActions\]/,
  );
  // Confirm the old overwrite-on-fallback pattern is gone.
  assert.doesNotMatch(
    stateExplorerSrc,
    /executedActions = await executeFormGroup\(page, formActions/,
    "fallback path must not overwrite executedActions directly",
  );
});

if (process.exitCode) process.exit(1);
console.log("\n🎉 Bundle-B state-explorer pins passed");
