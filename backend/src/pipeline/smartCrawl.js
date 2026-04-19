/**
 * smartCrawl.js — Layer 6: Intelligent crawling with structure deduplication
 *
 * Detects duplicate page layouts, avoids revisiting same structures,
 * prioritizes unique routes, stops exploring low-value paths.
 */

// ── URL value scoring ─────────────────────────────────────────────────────────

const HIGH_VALUE_PATHS = [
  "/login", "/signin", "/register", "/signup",
  "/checkout", "/cart", "/payment",
  "/dashboard", "/account", "/profile", "/settings",
  "/search", "/products", "/shop",
  "/admin", "/manage",
  "/contact", "/support",
];

const LOW_VALUE_PATHS = [
  "/cdn-", "/static/", "/assets/", "/images/", "/fonts/",
  "/favicon", "/robots", "/sitemap",
  "/.well-known",
];

const LOW_VALUE_EXTENSIONS = [
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
  ".css", ".js", ".woff", ".woff2", ".ttf",
  ".pdf", ".zip", ".xml", ".json",
];

export function scoreUrl(url, baseUrl) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();

    // Skip non-HTTP
    if (!url.startsWith("http")) return 0;

    // Skip binary/static files
    if (LOW_VALUE_EXTENSIONS.some(ext => path.endsWith(ext))) return 0;

    // Skip known noise paths
    if (LOW_VALUE_PATHS.some(p => path.includes(p))) return 0;

    // High value paths
    if (HIGH_VALUE_PATHS.some(p => path.includes(p))) return 100;

    // Penalize very deep paths (likely pagination / details)
    const depth = path.split("/").filter(Boolean).length;
    if (depth > 4) return 20;

    // Penalize query-string heavy URLs (likely filters, not new pages)
    if (u.searchParams.size > 2) return 15;

    // Penalize numbered segments (pagination: /page/2, /products/123)
    if (/\/\d+\/?$/.test(path)) return 25;

    // Default
    return 50;

  } catch { return 0; }
}

// ── Structure fingerprinting ──────────────────────────────────────────────────

/**
 * fingerprintStructure(snapshot) → string
 *
 * Creates a structural fingerprint of a page based on its DOM shape,
 * not its content. Used to detect "template" pages (e.g. blog post A vs B).
 */
export function fingerprintStructure(snapshot) {
  // Normalize elements to their tag+type shape, ignore text content
  const shape = (snapshot.elements || [])
    .map(el => `${el.tag}:${el.type || ""}`)
    .sort()
    .join(",");

  const formCount = snapshot.forms || 0;
  const hasH1 = snapshot.h1 ? "1" : "0";

  // Simple hash of the structural shape
  const str = `forms:${formCount}|h1:${hasH1}|${shape}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// ── Smart queue management ────────────────────────────────────────────────────

export class SmartCrawlQueue {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.visited = new Set();
    this.structuresSeen = new Set();
    this.queue = []; // { url, depth, score }
  }

  enqueue(url, depth) {
    if (this.visited.has(url)) return;
    if (!url.startsWith("http")) return;

    const score = scoreUrl(url, this.baseUrl);
    if (score === 0) return; // Skip worthless URLs

    this.queue.push({ url, depth, score });

    // Keep queue sorted by score (high value first)
    this.queue.sort((a, b) => b.score - a.score);
  }

  dequeue() {
    return this.queue.shift() || null;
  }

  markVisited(url) {
    this.visited.add(url);
  }

  markStructureSeen(fingerprint) {
    this.structuresSeen.add(fingerprint);
  }

  isStructureDuplicate(fingerprint) {
    return this.structuresSeen.has(fingerprint);
  }

  get size() { return this.queue.length; }
  get visitedCount() { return this.visited.size; }

  hasMore() { return this.queue.length > 0; }
}

// ── Path deduplication ────────────────────────────────────────────────────────

/**
 * extractPathPattern(url) → string
 *
 * Converts /products/123 and /products/456 to /products/:id
 * so we only crawl one version.
 */
export function extractPathPattern(url) {
  try {
    const u = new URL(url);
    const pattern = u.pathname
      .split("/")
      .map(segment => /^\d+$/.test(segment) ? ":id" : segment)
      .join("/");
    return `${u.hostname}${pattern}`;
  } catch { return url; }
}

// ── Query-param-aware path deduplication (#52 defect #1) ─────────────────────

/**
 * Query parameter names that carry state-significant meaning.
 * Exported so stateFingerprint.js can reuse the same set (DRY).
 */
export const SIGNIFICANT_PARAMS = new Set([
  "category", "sort", "order", "view", "tab", "page", "filter",
  "type", "status", "q", "query", "search", "mode", "step",
  "section", "panel", "lang", "locale",
]);

/**
 * Query parameter patterns that are always noise.
 * Exported so stateFingerprint.js can reuse the same list (DRY).
 */
export const NOISE_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^_ga$/i, /^mc_/i,
  /^ref$/i, /^source$/i, /token/i, /session/i, /nonce/i,
  /timestamp/i, /^_$/i, /^cb$/i, /^t$/i,
];

/**
 * extractPathPatternWithParams(url) → string
 *
 * Like {@link extractPathPattern} but includes significant query parameters
 * in the pattern so `/products?category=electronics` and
 * `/products?category=books` produce different patterns.
 *
 * Used by the state explorer where query params are preserved (#52 defect #1).
 * The original {@link extractPathPattern} (without params) is still used by
 * crawlBrowser.js where query params are stripped before pattern extraction.
 *
 * @param {string} url
 * @returns {string}
 */
export function extractPathPatternWithParams(url) {
  try {
    const u = new URL(url);
    const pattern = u.pathname
      .split("/")
      .map(segment => /^\d+$/.test(segment) ? ":id" : segment)
      .join("/");

    // Include significant query params in sorted order
    const sigParams = [];
    for (const [key, value] of u.searchParams) {
      if (NOISE_PARAMS.some(re => re.test(key))) continue;
      if (SIGNIFICANT_PARAMS.has(key.toLowerCase())) {
        sigParams.push(`${key.toLowerCase()}=${value}`);
      }
    }
    sigParams.sort();
    const qStr = sigParams.length > 0 ? `?${sigParams.join("&")}` : "";

    return `${u.hostname}${pattern}${qStr}`;
  } catch { return url; }
}

/**
 * Strip noise query parameters from a URL, preserving significant ones.
 *
 * Shared utility for both crawlBrowser.js and stateExplorer.js so link
 * normalisation is consistent across crawl modes (#52 defect #1).
 *
 * @param {URL} u — mutable URL object (modified in place)
 */
export function stripNoiseParams(u) {
  for (const key of [...u.searchParams.keys()]) {
    if (NOISE_PARAMS.some(re => re.test(key))) u.searchParams.delete(key);
  }
}
