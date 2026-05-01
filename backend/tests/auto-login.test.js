/**
 * @module tests/auto-login
 * @description Unit tests for `pipeline/autoLogin.js` `performAutoLogin()`.
 *
 * Exercises the locator waterfall against a real Chromium page driven by
 * Playwright's data: URL loader so each fixture is a self-contained HTML
 * snippet — no fixtures directory, no live network. Covers the common
 * shapes the heuristic must recognise, plus negative cases.
 *
 * Cases:
 *   1. `<input type="email"> + <input type="password"> + <button type="submit">`
 *      — the canonical happy path. All three locators win on their first
 *      strategy.
 *   2. Generic `<input type="text" name="user">` with role-named submit
 *      ("Sign In") — exercises the name-attribute fallback for username and
 *      the role-button strategy for submit.
 *   3. No submit button — exercises the Enter-key fallback.
 *   4. Missing username field — returns `{ ok: false, reason }`.
 *   5. Missing password field — returns `{ ok: false, reason }`.
 *   6. Empty creds — returns `{ ok: false }` without launching a browser
 *      query.
 */
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { performAutoLogin } from "../src/pipeline/autoLogin.js";
import { createTestContext } from "./helpers/test-base.js";

/** Wrap a fragment in a minimal HTML document and load it via data: URL. */
async function loadHtml(page, body) {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  await page.goto(url);
}

async function main() {
  const t = createTestContext();
  const runner = t.createTestRunner();

  // Backend CI intentionally does not install Playwright browser binaries
  // (see `backend/tests/cross-browser.test.js` preamble). If chromium is
  // unavailable locally, the three live-DOM cases are skipped and only the
  // browser-free guard case runs — the full suite is exercised in the
  // separate cross-browser workflow where browsers are preinstalled.
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes("Executable doesn't exist") || msg.includes("playwright install")) {
      console.log("⏭️  auto-login: chromium not installed in this env, skipping live-DOM cases");
    } else {
      throw err;
    }
  }

  try {
    if (!browser) {
      // Only the browser-free guard case is runnable without chromium.
      await runner.test("Blank credentials short-circuit without touching the page", async () => {
        const result = await performAutoLogin(null, { username: "", password: "" });
        assert.equal(result.ok, false);
        assert.match(result.reason || "", /required/i);
      });
      runner.summary("auto-login");
      return;
    }

    await runner.test("Canonical email/password/submit form succeeds via primary strategies", async () => {
      const page = await browser.newPage();
      try {
        await loadHtml(page, `
          <form id="login" action="javascript:void(0)">
            <input type="email" name="email" />
            <input type="password" name="password" />
            <button type="submit">Sign in</button>
          </form>
          <script>
            document.getElementById("login").addEventListener("submit", (e) => {
              window.__submitted = {
                email: document.querySelector('input[type=email]').value,
                password: document.querySelector('input[type=password]').value,
              };
            });
          </script>
        `);
        const result = await performAutoLogin(page, { username: "alice@example.com", password: "secret" }, { timeout: 1500 });
        assert.equal(result.ok, true, `expected success, got reason: ${result.reason}`);
        const submitted = await page.evaluate(() => window.__submitted);
        assert.deepEqual(submitted, { email: "alice@example.com", password: "secret" });
      } finally {
        await page.close();
      }
    });

    await runner.test("Generic text input + role-named button is detected via name-attr + getByRole", async () => {
      const page = await browser.newPage();
      try {
        await loadHtml(page, `
          <form id="login" action="javascript:void(0)">
            <input type="text" name="user" />
            <input type="password" name="pwd" />
            <button>Log In</button>
          </form>
          <script>
            document.getElementById("login").addEventListener("submit", (e) => {
              window.__submitted = {
                user: document.querySelector('input[name=user]').value,
                pwd: document.querySelector('input[name=pwd]').value,
              };
            });
          </script>
        `);
        const result = await performAutoLogin(page, { username: "bob", password: "hunter2" }, { timeout: 1500 });
        assert.equal(result.ok, true, `expected success, got reason: ${result.reason}`);
        const submitted = await page.evaluate(() => window.__submitted);
        assert.deepEqual(submitted, { user: "bob", pwd: "hunter2" });
      } finally {
        await page.close();
      }
    });

    await runner.test("No submit button → fallback to Enter on password field submits the form", async () => {
      const page = await browser.newPage();
      try {
        await loadHtml(page, `
          <form id="login" action="javascript:void(0)">
            <input type="email" name="email" />
            <input type="password" name="password" />
          </form>
          <script>
            document.getElementById("login").addEventListener("submit", (e) => {
              window.__submitted = true;
            });
          </script>
        `);
        const result = await performAutoLogin(page, { username: "alice@example.com", password: "secret" }, { timeout: 1500 });
        assert.equal(result.ok, true, `expected success, got reason: ${result.reason}`);
        const submitted = await page.evaluate(() => window.__submitted);
        assert.equal(submitted, true);
      } finally {
        await page.close();
      }
    });

    await runner.test("Missing username field returns ok:false with descriptive reason", async () => {
      const page = await browser.newPage();
      try {
        await loadHtml(page, `<form><input type="password" /></form>`);
        const result = await performAutoLogin(page, { username: "x", password: "y" }, { timeout: 500 });
        assert.equal(result.ok, false);
        assert.match(result.reason || "", /username/i);
      } finally {
        await page.close();
      }
    });

    await runner.test("Missing password field returns ok:false", async () => {
      const page = await browser.newPage();
      try {
        await loadHtml(page, `<form><input type="email" /></form>`);
        const result = await performAutoLogin(page, { username: "x", password: "y" }, { timeout: 500 });
        assert.equal(result.ok, false);
        assert.match(result.reason || "", /password/i);
      } finally {
        await page.close();
      }
    });

    await runner.test("Blank credentials short-circuit without touching the page", async () => {
      // No page is required — the early-return guard fires before any DOM access.
      const result = await performAutoLogin(/* page= */ null, { username: "", password: "" });
      assert.equal(result.ok, false);
      assert.match(result.reason || "", /required/i);
    });

    runner.summary("auto-login");
  } finally {
    if (browser) await browser.close();
  }
}

main().catch((err) => {
  console.error("❌ auto-login failed:", err);
  process.exit(1);
});
