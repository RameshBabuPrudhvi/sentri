/**
 * @module tests/csrf
 * @description Unit tests for the getCsrfToken and setCsrfToken utilities.
 */

import assert from "node:assert/strict";

const originalDocument = global.document;

(async () => {
  try {
    // Set up initial document mock before import
    global.document = { cookie: "_csrf=abc123" };
    const { getCsrfToken, setCsrfToken, _resetCsrfTokenForTesting } = await import("../src/utils/csrf.js");

    // ── Returns token from _csrf cookie ────────────────────────────────
    assert.equal(getCsrfToken(), "abc123", "Should read _csrf cookie value");

    // ── Returns empty string when no _csrf cookie ──────────────────────
    global.document = { cookie: "other=value; session=xyz" };
    assert.equal(getCsrfToken(), "", "Should return empty when _csrf is absent");

    // ── Returns empty string when document.cookie is empty ─────────────
    global.document = { cookie: "" };
    assert.equal(getCsrfToken(), "", "Should return empty for empty cookie string");

    // ── Handles multiple cookies correctly ─────────────────────────────
    global.document = { cookie: "foo=bar; _csrf=mytoken; baz=qux" };
    assert.equal(getCsrfToken(), "mytoken", "Should find _csrf among multiple cookies");

    // ── Returns empty string when document is undefined ────────────────
    global.document = undefined;
    assert.equal(getCsrfToken(), "", "Should return empty when document is undefined");

    // ── setCsrfToken stores a token that getCsrfToken returns ──────────
    // (cross-origin: token comes from response header, not cookie)
    setCsrfToken("from-header");
    assert.equal(getCsrfToken(), "from-header", "Should return token set via setCsrfToken");

    // ── In-memory token takes precedence over cookie ───────────────────
    global.document = { cookie: "_csrf=cookie-value" };
    assert.equal(getCsrfToken(), "from-header", "In-memory token should take precedence over cookie");

    // ── setCsrfToken ignores falsy values ──────────────────────────────
    setCsrfToken("");
    assert.equal(getCsrfToken(), "from-header", "setCsrfToken should ignore empty string");
    setCsrfToken(null);
    assert.equal(getCsrfToken(), "from-header", "setCsrfToken should ignore null");

    // ── _resetCsrfTokenForTesting clears in-memory token ───────────────
    _resetCsrfTokenForTesting();
    global.document = { cookie: "_csrf=after-reset" };
    assert.equal(getCsrfToken(), "after-reset", "After reset, should fall back to cookie");

    console.log("✅ csrf: all checks passed");
  } catch (err) {
    console.error("❌ csrf failed:", err);
    process.exit(1);
  } finally {
    global.document = originalDocument;
  }
})();
