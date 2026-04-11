/**
 * @module tests/csrf
 * @description Unit tests for the getCsrfToken utility.
 */

import assert from "node:assert/strict";

const originalDocument = global.document;

(async () => {
  try {
    // Set up initial document mock before import
    global.document = { cookie: "_csrf=abc123" };
    const { getCsrfToken } = await import("../src/utils/csrf.js");

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

    console.log("✅ csrf: all checks passed");
  } catch (err) {
    console.error("❌ csrf failed:", err);
    process.exit(1);
  } finally {
    global.document = originalDocument;
  }
})();
