/**
 * @module tests/more-utils
 * @description Unit tests for additional frontend utility modules.
 */

import assert from "node:assert/strict";
import { cleanTestName } from "../src/utils/formatTestName.js";
import { loadSavedConfig, saveConfig, countActiveDials } from "../src/utils/testDialsStorage.js";
import { csvEscape, buildCsv, downloadCsv } from "../src/utils/exportCsv.js";
import { parseJsonResponse } from "../src/utils/apiBase.js";
import { escapeHtml } from "../src/utils/pdfReportHtml.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log("\n🧪 formatTestName");

test("cleanTestName strips known scenario prefixes", () => {
  assert.equal(cleanTestName("POSITIVE: User logs in"), "User logs in");
  assert.equal(cleanTestName("EDGE CASE - Handles empty state"), "Handles empty state");
  assert.equal(cleanTestName("NEGATIVE — Shows validation"), "Shows validation");
});

test("cleanTestName preserves non-prefixed names", () => {
  assert.equal(cleanTestName("Login success flow"), "Login success flow");
  assert.equal(cleanTestName(null), null);
});

console.log("\n🧪 testDialsStorage");

test("loadSavedConfig merges saved options with defaults", () => {
  const originalStorage = global.localStorage;
  global.localStorage = {
    getItem() {
      return JSON.stringify({
        approach: "balanced",
        options: { includeA11y: true },
      });
    },
  };

  const loaded = loadSavedConfig();
  assert.equal(loaded.approach, "balanced");
  assert.equal(typeof loaded.options, "object");
  assert.equal(loaded.options.includeA11y, true);

  global.localStorage = originalStorage;
});

test("saveConfig persists JSON and countActiveDials counts non-default values", () => {
  const originalStorage = global.localStorage;
  let stored = null;
  global.localStorage = {
    setItem(key, value) {
      stored = { key, value };
    },
    getItem() {
      return null;
    },
  };

  const cfg = {
    approach: "strict",
    perspectives: ["qa"],
    quality: ["reliability"],
    format: "gherkin",
    testCount: "3",
    exploreMode: "exploratory",
    parallelWorkers: 2,
    options: { includeA11y: true, includeApi: false },
  };

  saveConfig(cfg);
  assert.equal(stored.key, "app_test_dials");
  assert.match(stored.value, /strict/);
  assert.equal(countActiveDials(cfg), 8);
  assert.equal(countActiveDials(null), 0);

  global.localStorage = originalStorage;
});

console.log("\n🧪 exportCsv + api utils");

test("csvEscape and buildCsv format output safely", () => {
  assert.equal(csvEscape('a"b'), '"a""b"');
  const csv = buildCsv(["name", "value"], [["alpha", 1], ["beta", "x,y"]]);
  assert.match(csv, /"name","value"/);
  assert.match(csv, /"beta","x,y"/);
});

test("downloadCsv creates object URL and clicks anchor", () => {
  const originalDocument = global.document;
  const originalURL = global.URL;
  const originalSetTimeout = global.setTimeout;

  let clicked = 0;
  let revoked = 0;
  global.document = {
    createElement() {
      return {
        click() {
          clicked += 1;
        },
      };
    },
  };
  global.URL = {
    createObjectURL() {
      return "blob:test";
    },
    revokeObjectURL() {
      revoked += 1;
    },
  };
  global.setTimeout = (fn) => {
    fn();
    return 0;
  };

  downloadCsv("a,b\n1,2", "report.csv");
  assert.equal(clicked, 1);
  assert.equal(revoked, 1);

  global.document = originalDocument;
  global.URL = originalURL;
  global.setTimeout = originalSetTimeout;
});

await testAsync("parseJsonResponse returns JSON for application/json", async () => {
  const data = await parseJsonResponse({
    headers: { get: () => "application/json; charset=utf-8" },
    json: async () => ({ ok: true }),
  });
  assert.deepEqual(data, { ok: true });
});

await testAsync("parseJsonResponse throws for non-JSON responses", async () => {
  await assert.rejects(
    () => parseJsonResponse({ headers: { get: () => "text/html" }, json: async () => ({}) }),
    /Unable to reach the server/
  );
});

console.log("\n🧪 escapeHtml (pdfReportHtml XSS prevention)");

test("escapeHtml escapes <script> tags", () => {
  assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("escapeHtml escapes & < > \" ' characters", () => {
  assert.equal(escapeHtml('&<>"\''), "&amp;&lt;&gt;&quot;&#x27;");
});

test("escapeHtml returns empty string for null", () => {
  assert.equal(escapeHtml(null), "");
});

test("escapeHtml returns empty string for undefined", () => {
  assert.equal(escapeHtml(undefined), "");
});

test("escapeHtml coerces numbers to string", () => {
  assert.equal(escapeHtml(42), "42");
});

test("escapeHtml handles empty string", () => {
  assert.equal(escapeHtml(""), "");
});

test("escapeHtml escapes img onerror XSS payload", () => {
  const payload = '<img src=x onerror=alert(1)>';
  const escaped = escapeHtml(payload);
  assert.ok(!escaped.includes("<img"), "Should not contain raw <img tag");
  assert.ok(!escaped.includes("<"), "Should not contain any raw < character");
  assert.match(escaped, /&lt;img/);
});

test("escapeHtml escapes HTML attribute breakout", () => {
  const payload = '" onmouseover="alert(1)';
  const escaped = escapeHtml(payload);
  assert.ok(!escaped.includes('"'), "Should not contain raw double quotes");
  assert.match(escaped, /&quot;/);
});

test("escapeHtml preserves safe text unchanged", () => {
  assert.equal(escapeHtml("Hello World 123"), "Hello World 123");
});

test("escapeHtml handles mixed safe and unsafe content", () => {
  assert.equal(escapeHtml("Tom & Jerry <3"), "Tom &amp; Jerry &lt;3");
});

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n⚠️  Frontend utility tests failed");
  process.exit(1);
}

console.log("\n🎉 Additional frontend utility tests passed");
