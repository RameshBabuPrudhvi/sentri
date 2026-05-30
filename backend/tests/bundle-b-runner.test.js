/**
 * @module tests/bundle-b-runner
 * @description Bundle-B fixes #1-#6 — runner / executeTest reliability pins.
 *
 * Lifecycle-touching fixes (downloads dir, browser-health probe, screencast
 * teardown ordering, async FS cleanup) are pinned via source-grep + a stub-
 * driven executeTest call rather than booting a real browser. The
 * integration surface is covered by the Golden E2E re-run required at merge
 * time per the bundle spec.
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

console.log("\n⚙️  Bundle-B runner pins (fixes #1–#6)");

const executeTestSrc = fs.readFileSync(
  new URL("../src/runner/executeTest.js", import.meta.url),
  "utf8",
);

// ── Fix #1: network log race uses Request identity ──────────────────────────
await test("#1 attachPageListeners pairs entries via WeakMap on Request", () => {
  assert.match(executeTestSrc, /const requestEntries = new WeakMap\(\)/);
  assert.match(executeTestSrc, /requestEntries\.set\(req, entry\)/);
  assert.match(executeTestSrc, /requestEntries\.get\(res\.request\(\)\)/);
});

// ── Fix #2 + BUG-0001 + BUG-0004 — timeout handler contract ────────────────
// The original Bundle-B fix #2 said "stopScreencast must run BEFORE
// reject()" — but the bug catcher (BUG-0001) caught that this could
// hang forever when Chromium itself is the unresponsive party: the
// await on stopScreencast would never resolve because the CDP socket
// was dead, so reject() never fired, so the per-test timeout circuit
// breaker stopped working. The fix flips the order: reject FIRST
// (synchronously), then schedule the screencast stop + page close as
// fire-and-forget cleanup. The ordering between stopScreencast and
// page.close is preserved inside the post-reject cleanup chain so the
// CDP session isn't asked to flush on a dead page (the original
// Bundle-B #2 intent), but neither blocks the timeout itself.
//
// BUG-0004 — the cleanup chain ALSO nulls `stopScreencast` so the
// `finally` block's `if (stopScreencast)` check skips the second call.
// Without this, every timed-out test double-calls the CDP detach and
// produces duplicate "[screencast] stopped" log lines.
await test("#2 timeout handler rejects synchronously, cleans up async, no double stopScreencast", () => {
  const rejectIdx = executeTestSrc.indexOf("reject(new Error(`Browser test timed out");
  const stopCallIdx = executeTestSrc.indexOf("_stop ? _stop() : null");
  const nullStopIdx = executeTestSrc.indexOf("stopScreencast = null;");
  const pageCloseInTimeoutIdx = executeTestSrc.indexOf("page.close().catch(() => {}); });");

  assert.ok(rejectIdx > 0, "timeout reject marker must be present");
  assert.ok(stopCallIdx > 0, "fire-and-forget stopScreencast call must be present");
  assert.ok(nullStopIdx > 0, "stopScreencast = null marker must be present (BUG-0004)");
  assert.ok(pageCloseInTimeoutIdx > 0, "deferred page.close in timeout handler must be present");

  // BUG-0001 — reject must come BEFORE the cleanup work (the opposite
  // of the old Bundle-B #2 ordering).
  assert.ok(rejectIdx < stopCallIdx,
    "reject() must run synchronously BEFORE the async stopScreencast cleanup");
  assert.ok(rejectIdx < nullStopIdx,
    "reject() must run BEFORE the stopScreencast = null assignment");

  // The broken BUG-0001 shape was `await stopScreencast()` inside the
  // setTimeout async callback. The `await` keyword must NOT appear
  // between the `setTimeout(` opening and the matching `reject(`.
  // (The same pattern is fine in the post-test `finally` block at the
  // bottom of executeTest — there it's BUG-0004's null-guarded second
  // call, which is the correct protection, not the bug.)
  const setTimeoutIdx = executeTestSrc.indexOf("setTimeout(", executeTestSrc.indexOf("testTimeoutPromise"));
  const timeoutBlock = executeTestSrc.slice(setTimeoutIdx, rejectIdx);
  assert.ok(
    !/\bawait\s+stopScreencast\s*\(/.test(timeoutBlock),
    "stopScreencast must NOT be awaited inside the setTimeout callback before reject() — that's the BUG-0001 hang shape",
  );
});

// ── Fix #3: video cleanup uses fs/promises ─────────────────────────────────
await test("#3 video cleanup hook uses fs/promises (no Sync calls in hot path)", () => {
  const startIdx = executeTestSrc.indexOf("if (videoEnabled) {");
  assert.ok(startIdx > 0, "videoEnabled cleanup block must exist");
  const blockEnd = executeTestSrc.indexOf("await fsp.rm(testDownloadsDir", startIdx);
  assert.ok(blockEnd > startIdx, "must locate the end of the cleanup block");
  const block = executeTestSrc.slice(startIdx, blockEnd);
  for (const banned of ["readFileSync", "unlinkSync", "renameSync", "rmSync", "readdirSync"]) {
    assert.ok(!block.includes(banned),
      `${banned} must not appear in the cleanup hot path`);
  }
  assert.match(block, /await fsp\./);
});

// ── Fix #4: networkLogs ring buffer cap ─────────────────────────────────────
await test("#4 networkLogs ring buffer caps at 500 (eviction policy)", () => {
  assert.match(executeTestSrc, /const MAX_NETWORK_LOG_ENTRIES = 500/);
  assert.match(
    executeTestSrc,
    /if \(networkLogs\.length >= MAX_NETWORK_LOG_ENTRIES\) \{[\s\S]{0,80}networkLogs\.shift\(\);/,
  );
  // Behavioural pin: model the ring buffer to prove the contract.
  const MAX = 500;
  const logs = [];
  for (let i = 0; i < 1000; i++) {
    if (logs.length >= MAX) logs.shift();
    logs.push({ id: i });
  }
  assert.equal(logs.length, MAX);
  assert.equal(logs[0].id, 500);
  assert.equal(logs[MAX - 1].id, 999);
});

// ── Fix #5: disconnected browser → ERR_BROWSER_DISCONNECTED ─────────────────
await test("#5 disconnected browser triggers structured ERR_BROWSER_DISCONNECTED", async () => {
  const { executeTest } = await import("../src/runner/executeTest.js");
  const fakeBrowser = { isConnected: () => false };
  const t = {
    id: "TC-X",
    name: "browser test",
    playwrightCode: "test('x', async ({ page }) => { await page.goto('about:blank'); });",
  };
  let thrown = null;
  try {
    await executeTest(t, fakeBrowser, "run-1", 0, Date.now(), {});
  } catch (e) { thrown = e; }
  assert.ok(thrown, "executeTest must throw when browser is disconnected");
  assert.equal(thrown.code, "ERR_BROWSER_DISCONNECTED");
  assert.equal(thrown.recoverable, true);
});

// ── Fix #6: per-run downloads dir under os.tmpdir() ─────────────────────────
await test("#6 per-run downloads dir scoped under os.tmpdir() + wiped on cleanup", () => {
  assert.match(
    executeTestSrc,
    /path\.join\(os\.tmpdir\(\), "sentri-downloads", runId, `step\$\{stepIndex\}`\)/,
  );
  assert.match(executeTestSrc, /downloadsPath: testDownloadsDir/);
  assert.match(
    executeTestSrc,
    /await fsp\.rm\(testDownloadsDir, \{ recursive: true, force: true \}\)/,
  );
});

if (process.exitCode) process.exit(1);
console.log("\n🎉 Bundle-B runner pins passed");
