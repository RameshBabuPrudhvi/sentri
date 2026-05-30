/**
 * @module tests/b2-iframe-crawl
 * @description AUDIT-ROADMAP Bundle 2 — end-to-end coverage for
 * `pipeline/iframeEnumeration.js#enumerateFrameSnapshots` against a real
 * Chromium browser pointed at a local same-origin HTTP fixture.
 *
 * Why a real browser + real HTTP server: `data:text/html;...` URLs each
 * have their own opaque origin per browser policy, so two `data:` URLs
 * can NEVER be same-origin. iframe enumeration's `same-origin` strategy
 * needs an actual matching origin between the parent and the embedded
 * frame — only a local `http.createServer` provides that.
 *
 * Cases (all exercised when Chromium is installed; the suite degrades
 * gracefully when it isn't — `cross-browser.test.js` uses the same
 * conditional-skip pattern):
 *
 *   1. **same-origin strategy + matching frame** — parent at
 *      `http://127.0.0.1:PORT/parent` embeds `<iframe src="/widget">`.
 *      `enumerateFrameSnapshots` returns `count: 1`, `skipped: 0`, and
 *      `frameElements` contains the iframe's button tagged with
 *      `_fromIframe: true` + `_iframeSrc` pointing at the widget URL.
 *   2. **strategy === 'none'** — opt-out path: same parent + frame, but
 *      `project.iframeStrategy = 'none'` short-circuits before iterating
 *      frames. Returns `{ count: 0, skipped: 0, frameElements: [] }`.
 *   3. **allowlist strategy + matching prefix** — same parent + frame,
 *      `iframeStrategy: 'allowlist'` with the widget URL prefix in the
 *      allowlist. Returns `count: 1` and `frameElements` populated.
 *   4. **allowlist strategy + non-matching prefix** — same parent + frame,
 *      but the allowlist contains an unrelated prefix. Returns
 *      `count: 0, skipped: 1` (the frame is filtered before snapshot).
 *
 * The suite uses a stub `run` object so the persistence path
 * (`crawlSnapshotRepo.save`) is exercised but tolerates a missing DB —
 * the helper's persist branch is wrapped in try/catch, so the test
 * verifies the in-memory contract without standing up SQLite.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "@playwright/test";
import { createTestContext } from "./helpers/test-base.js";
import { enumerateFrameSnapshots, shouldEnumerateFrame } from "../src/pipeline/iframeEnumeration.js";

// ── Local fixture: two same-origin pages served from a single HTTP server ──
//
// The parent embeds the widget via `<iframe src="/widget">`. Both endpoints
// return minimal HTML with a single interactive button so the iframe
// element list comes back deterministic — the test asserts the button's
// `text` field matches the literal "Buy now" we render below.

function startFixtureServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/parent") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
<h1>Parent page</h1>
<button>Parent action</button>
<iframe src="/widget" title="Embedded widget" style="width:300px;height:200px;border:1px solid #ccc"></iframe>
</body></html>`);
        return;
      }
      if (req.url === "/widget") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
<h1>Widget</h1>
<button>Buy now</button>
<input type="text" placeholder="Enter promo code" />
</body></html>`);
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server.address() returned a non-object — port unknown"));
        return;
      }
      resolve({ server, port: address.port });
    });
    server.on("error", reject);
  });
}

// Minimal `run` stub matching the shape `enumerateFrameSnapshots` reads.
// The helper calls `crawlSnapshotRepo.save(run.id, ...)` which is a thin
// SQLite write — we bypass that branch by NOT initialising a DB in this
// test (the save call lands in the try/persistErr arm and is logged but
// not thrown). The function's contract is unchanged: counts + elements
// are returned regardless of persistence success.
function makeRunStub() {
  return {
    id: `b2-iframe-test-${Date.now()}`,
    logs: [],
  };
}

async function main() {
  const t = createTestContext();
  const runner = t.createTestRunner();

  // Pure-function smoke test runs regardless of Chromium availability —
  // mirrors the existing unit coverage in `b2-adaptive-timeout.test.js`
  // so a failed Chromium probe still exercises the strategy gate.
  await runner.test("shouldEnumerateFrame: pure-function gate is stable", () => {
    assert.equal(shouldEnumerateFrame("http://localhost:1/w", "http://localhost:1/p", "same-origin"), true);
    assert.equal(shouldEnumerateFrame("about:blank", "http://localhost:1/p", "all"), false);
  });

  // Backend CI intentionally does not install Playwright browser binaries
  // (see `cross-browser.test.js` preamble for the rationale). When
  // chromium is unavailable, log + skip the browser-driven cases — the
  // separate cross-browser workflow exercises them where browsers are
  // preinstalled.
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes("Executable doesn't exist") || msg.includes("playwright install")) {
      console.log("⏭️  b2-iframe-crawl: chromium not installed in this env, skipping browser cases");
      runner.summary("b2-iframe-crawl");
      return;
    }
    throw err;
  }

  const { server, port } = await startFixtureServer();
  const PARENT_URL = `http://127.0.0.1:${port}/parent`;
  const WIDGET_URL = `http://127.0.0.1:${port}/widget`;

  try {
    await runner.test("same-origin strategy captures the iframe + merges its elements with _fromIframe: true", async () => {
      const page = await browser.newPage();
      try {
        await page.goto(PARENT_URL, { waitUntil: "domcontentloaded" });
        const project = { iframeStrategy: "same-origin", iframeAllowlist: [], hydrationType: "domcontentloaded" };
        const result = await enumerateFrameSnapshots(page, PARENT_URL, project, makeRunStub());

        assert.equal(result.count, 1, `expected 1 captured frame, got ${result.count}`);
        assert.equal(result.skipped, 0, `expected 0 skipped frames, got ${result.skipped}`);
        assert.ok(result.frameElements.length >= 1, `expected ≥1 frame element, got ${result.frameElements.length}`);

        const buyButton = result.frameElements.find((el) => /buy now/i.test(el.text || ""));
        assert.ok(buyButton, "did not find the 'Buy now' button inside the captured iframe elements");
        assert.equal(buyButton._fromIframe, true, "iframe element missing _fromIframe: true flag");
        assert.equal(buyButton._iframeSrc, WIDGET_URL, `_iframeSrc mismatch: expected ${WIDGET_URL}, got ${buyButton._iframeSrc}`);
      } finally {
        await page.close();
      }
    });

    await runner.test("strategy === 'none' short-circuits before iterating frames", async () => {
      const page = await browser.newPage();
      try {
        await page.goto(PARENT_URL, { waitUntil: "domcontentloaded" });
        const project = { iframeStrategy: "none", iframeAllowlist: [], hydrationType: "domcontentloaded" };
        const result = await enumerateFrameSnapshots(page, PARENT_URL, project, makeRunStub());

        assert.equal(result.count, 0);
        assert.equal(result.skipped, 0);
        assert.deepEqual(result.frameElements, []);
      } finally {
        await page.close();
      }
    });

    await runner.test("allowlist strategy with a matching prefix captures the frame", async () => {
      const page = await browser.newPage();
      try {
        await page.goto(PARENT_URL, { waitUntil: "domcontentloaded" });
        const project = {
          iframeStrategy: "allowlist",
          iframeAllowlist: [`http://127.0.0.1:${port}/`],
          hydrationType: "domcontentloaded",
        };
        const result = await enumerateFrameSnapshots(page, PARENT_URL, project, makeRunStub());

        assert.equal(result.count, 1, `expected 1 captured frame under allowlist, got ${result.count}`);
        assert.ok(result.frameElements.length >= 1);
      } finally {
        await page.close();
      }
    });

    await runner.test("allowlist strategy with a non-matching prefix skips the frame before snapshot", async () => {
      const page = await browser.newPage();
      try {
        await page.goto(PARENT_URL, { waitUntil: "domcontentloaded" });
        const project = {
          iframeStrategy: "allowlist",
          iframeAllowlist: ["https://js.stripe.com/"],
          hydrationType: "domcontentloaded",
        };
        const result = await enumerateFrameSnapshots(page, PARENT_URL, project, makeRunStub());

        assert.equal(result.count, 0, `expected 0 captured frames (non-matching allowlist), got ${result.count}`);
        assert.equal(result.skipped, 1, `expected 1 skipped frame, got ${result.skipped}`);
        assert.deepEqual(result.frameElements, []);
      } finally {
        await page.close();
      }
    });

    runner.summary("b2-iframe-crawl");
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error("❌ b2-iframe-crawl failed:", err);
  process.exit(1);
});
