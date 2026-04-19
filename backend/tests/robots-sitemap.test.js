/**
 * robots-sitemap.test.js — Unit tests for robots.txt + sitemap.xml parsing
 *
 * Run with: node tests/robots-sitemap.test.js
 * No test framework required — uses Node's built-in assert.
 */

import assert from "node:assert/strict";
import { parseRobotsTxt, isAllowed, parseSitemapXml } from "../src/utils/robotsSitemap.js";

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
    failed++;
  }
}

// ── robots.txt parsing ───────────────────────────────────────────────────────

console.log("\n🤖 robots.txt parsing");

test("parses Disallow rules for wildcard user-agent", () => {
  const txt = `User-agent: *
Disallow: /admin/
Disallow: /private/
Allow: /admin/public/`;
  const { rules } = parseRobotsTxt(txt);
  assert.equal(rules.length, 3);
  // Sorted by pattern length descending
  assert.equal(rules[0].pattern, "/admin/public/");
  assert.equal(rules[0].allow, true);
  assert.equal(rules[1].pattern, "/private/");
  assert.equal(rules[1].allow, false);
});

test("prefers Sentri-specific rules over wildcard", () => {
  const txt = `User-agent: *
Disallow: /

User-agent: Sentri
Disallow: /secret/
Allow: /`;
  const { rules } = parseRobotsTxt(txt);
  // Should use Sentri group, not wildcard
  assert.equal(rules.length, 2);
  assert.ok(rules.some(r => r.pattern === "/secret/" && !r.allow));
  assert.ok(rules.some(r => r.pattern === "/" && r.allow));
});

test("extracts Sitemap directives", () => {
  const txt = `User-agent: *
Disallow: /tmp/

Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap-posts.xml`;
  const { sitemaps } = parseRobotsTxt(txt);
  assert.equal(sitemaps.length, 2);
  assert.equal(sitemaps[0], "https://example.com/sitemap.xml");
  assert.equal(sitemaps[1], "https://example.com/sitemap-posts.xml");
});

test("handles empty robots.txt gracefully", () => {
  const { rules, sitemaps } = parseRobotsTxt("");
  assert.equal(rules.length, 0);
  assert.equal(sitemaps.length, 0);
});

test("ignores comments and blank lines", () => {
  const txt = `# This is a comment
User-agent: *

# Another comment
Disallow: /secret/
`;
  const { rules } = parseRobotsTxt(txt);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].pattern, "/secret/");
});

test("empty Disallow means allow all (skipped)", () => {
  const txt = `User-agent: *
Disallow:`;
  const { rules } = parseRobotsTxt(txt);
  assert.equal(rules.length, 0);
});

test("strips inline comments from directive values", () => {
  const txt = `User-agent: *
Disallow: /admin/ # admin area
Allow: /admin/public/ # public section`;
  const { rules } = parseRobotsTxt(txt);
  assert.equal(rules.length, 2);
  assert.ok(rules.some(r => r.pattern === "/admin/" && !r.allow), "Disallow pattern should be /admin/ without comment");
  assert.ok(rules.some(r => r.pattern === "/admin/public/" && r.allow), "Allow pattern should be /admin/public/ without comment");
  // Verify isAllowed works correctly with stripped comments
  const robotsRules = { rules, sitemaps: [] };
  assert.equal(isAllowed("https://example.com/admin/settings", robotsRules), false);
  assert.equal(isAllowed("https://example.com/admin/public/page", robotsRules), true);
});

// ── isAllowed ────────────────────────────────────────────────────────────────

console.log("\n🚫 isAllowed checks");

test("allows URL when no rules exist", () => {
  assert.equal(isAllowed("https://example.com/anything", { rules: [], sitemaps: [] }), true);
});

test("blocks disallowed path", () => {
  const rules = parseRobotsTxt("User-agent: *\nDisallow: /admin/");
  assert.equal(isAllowed("https://example.com/admin/settings", rules), false);
});

test("allows non-matching path", () => {
  const rules = parseRobotsTxt("User-agent: *\nDisallow: /admin/");
  assert.equal(isAllowed("https://example.com/public/page", rules), true);
});

test("Allow overrides Disallow for more specific path", () => {
  const rules = parseRobotsTxt(`User-agent: *
Disallow: /admin/
Allow: /admin/public/`);
  assert.equal(isAllowed("https://example.com/admin/public/page", rules), true);
  assert.equal(isAllowed("https://example.com/admin/secret", rules), false);
});

test("handles null/undefined robotsRules gracefully", () => {
  assert.equal(isAllowed("https://example.com/page", null), true);
  assert.equal(isAllowed("https://example.com/page", undefined), true);
});

test("Disallow: / blocks everything", () => {
  const rules = parseRobotsTxt("User-agent: *\nDisallow: /");
  assert.equal(isAllowed("https://example.com/anything", rules), false);
  assert.equal(isAllowed("https://example.com/", rules), false);
});

test("Allow: / with Disallow: / allows everything (Allow is more specific or equal)", () => {
  const rules = parseRobotsTxt("User-agent: *\nDisallow: /\nAllow: /public/");
  // /public/ is longer than / so it wins
  assert.equal(isAllowed("https://example.com/public/page", rules), true);
  // / matches Disallow first (same length, but Disallow: / is shorter than Allow: /public/)
  assert.equal(isAllowed("https://example.com/other", rules), false);
});

// ── sitemap.xml parsing ──────────────────────────────────────────────────────

console.log("\n🗺️  sitemap.xml parsing");

test("extracts URLs from urlset sitemap", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/about</loc></url>
  <url><loc>https://example.com/contact</loc></url>
</urlset>`;
  const { urls, childSitemaps } = parseSitemapXml(xml);
  assert.equal(urls.length, 3);
  assert.equal(childSitemaps.length, 0);
  assert.ok(urls.includes("https://example.com/about"));
});

test("extracts child sitemaps from sitemapindex", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap>
</sitemapindex>`;
  const { urls, childSitemaps } = parseSitemapXml(xml);
  assert.equal(urls.length, 0);
  assert.equal(childSitemaps.length, 2);
  assert.ok(childSitemaps.includes("https://example.com/sitemap-posts.xml"));
});

test("handles empty/malformed XML gracefully", () => {
  const { urls, childSitemaps } = parseSitemapXml("");
  assert.equal(urls.length, 0);
  assert.equal(childSitemaps.length, 0);
});

test("extracts URLs when <loc> is not the first child element", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <lastmod>2024-01-01</lastmod>
    <changefreq>weekly</changefreq>
    <loc>https://example.com/page1</loc>
  </url>
  <url>
    <priority>0.8</priority>
    <loc>https://example.com/page2</loc>
    <lastmod>2024-02-01</lastmod>
  </url>
</urlset>`;
  const { urls } = parseSitemapXml(xml);
  assert.equal(urls.length, 2);
  assert.ok(urls.includes("https://example.com/page1"));
  assert.ok(urls.includes("https://example.com/page2"));
});

test("extracts child sitemaps when <loc> is not the first child", () => {
  const xml = `<sitemapindex>
  <sitemap>
    <lastmod>2024-01-01</lastmod>
    <loc>https://example.com/sitemap-pages.xml</loc>
  </sitemap>
</sitemapindex>`;
  const { childSitemaps } = parseSitemapXml(xml);
  assert.equal(childSitemaps.length, 1);
  assert.ok(childSitemaps.includes("https://example.com/sitemap-pages.xml"));
});

test("handles mixed sitemap with whitespace in loc", () => {
  const xml = `<urlset>
  <url><loc>  https://example.com/page1  </loc></url>
  <url><loc>
    https://example.com/page2
  </loc></url>
</urlset>`;
  const { urls } = parseSitemapXml(xml);
  assert.equal(urls.length, 2);
  assert.ok(urls.includes("https://example.com/page1"));
  assert.ok(urls.includes("https://example.com/page2"));
});

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) {
  console.log(`\n⚠️  ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log(`\n🎉 All tests passed!`);
}
