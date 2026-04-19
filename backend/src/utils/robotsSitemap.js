/**
 * @module utils/robotsSitemap
 * @description Fetches and parses robots.txt rules and sitemap.xml URLs for
 * crawl compliance. Zero external dependencies — uses the global `fetch()` API
 * available in Node 18+.
 *
 * ### Design decisions
 * - Only the `Sentri` and `*` user-agent groups are evaluated.
 * - `Allow` directives take precedence over `Disallow` when both match at the
 *   same specificity (longest prefix wins), matching Google's interpretation.
 * - Sitemap parsing handles both `<sitemapindex>` (recursive) and `<urlset>`
 *   formats. Gzip sitemaps are NOT supported (would require `zlib`); they are
 *   silently skipped.
 * - All network errors are swallowed — a missing or unreachable robots.txt
 *   means "allow everything", per the standard.
 *
 * ### Exports
 * - {@link loadRobotsRules}  — fetch + parse robots.txt → rules object
 * - {@link isAllowed}        — check a URL against parsed rules
 * - {@link loadSitemapUrls}  — fetch + parse sitemap.xml → URL list
 *
 * @see https://datatracker.ietf.org/doc/html/rfc9309
 */

// ── robots.txt parsing ───────────────────────────────────────────────────────

/**
 * @typedef {Object} RobotsRules
 * @property {Array<{pattern: string, allow: boolean}>} rules — sorted longest-first
 * @property {string[]} sitemaps — Sitemap URLs declared in robots.txt
 */

/**
 * Parse raw robots.txt content into structured rules.
 *
 * Only rules for `User-agent: Sentri` or `User-agent: *` are kept.
 * The Sentri-specific group takes priority if present.
 *
 * @param {string} text — raw robots.txt content
 * @returns {RobotsRules}
 */
export function parseRobotsTxt(text) {
  const lines = text.split(/\r?\n/);
  const sitemaps = [];

  // Collect rules per user-agent group
  /** @type {Map<string, Array<{pattern: string, allow: boolean}>>} */
  const groups = new Map();
  let currentAgents = [];

  for (const raw of lines) {
    const line = raw.trim();
    // Skip comments and empty lines
    if (!line || line.startsWith("#")) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (directive === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }

    if (directive === "user-agent") {
      const agent = value.toLowerCase();
      // If the previous line was also a user-agent, accumulate (multi-agent group)
      if (currentAgents.length > 0 && !groups.has(currentAgents[0])) {
        // Still building agent list for this group
        currentAgents.push(agent);
      } else {
        currentAgents = [agent];
      }
      continue;
    }

    if (directive === "allow" || directive === "disallow") {
      if (!value && directive === "disallow") continue; // empty Disallow = allow all
      for (const agent of currentAgents) {
        if (!groups.has(agent)) groups.set(agent, []);
        groups.get(agent).push({ pattern: value || "/", allow: directive === "allow" });
      }
    }
  }

  // Prefer Sentri-specific rules, fall back to wildcard
  const sentri = groups.get("sentri") || groups.get("sentri/1.0");
  const wildcard = groups.get("*");
  const rules = sentri || wildcard || [];

  // Sort by pattern length descending — longest match wins
  rules.sort((a, b) => b.pattern.length - a.pattern.length);

  return { rules, sitemaps };
}

/**
 * Fetch and parse robots.txt from a base URL.
 *
 * @param {string} baseUrl — site origin (e.g. "https://example.com")
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 * @returns {Promise<RobotsRules>}
 */
export async function loadRobotsRules(baseUrl, { timeoutMs = 5000 } = {}) {
  try {
    const origin = new URL(baseUrl).origin;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${origin}/robots.txt`, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Sentri/1.0)" },
    });
    clearTimeout(timer);
    if (!res.ok) return { rules: [], sitemaps: [] };
    const text = await res.text();
    return parseRobotsTxt(text);
  } catch {
    // Network error, timeout, or invalid URL — allow everything
    return { rules: [], sitemaps: [] };
  }
}

/**
 * Check whether a URL is allowed by the parsed robots.txt rules.
 *
 * Uses longest-prefix matching: the rule whose pattern is the longest prefix
 * of the URL path wins. If no rule matches, the URL is allowed (default).
 *
 * @param {string} url — full URL to check
 * @param {RobotsRules} robotsRules — from {@link loadRobotsRules}
 * @returns {boolean}
 */
export function isAllowed(url, robotsRules) {
  if (!robotsRules || !robotsRules.rules || robotsRules.rules.length === 0) return true;
  try {
    const path = new URL(url).pathname;
    // Find the first (longest) matching rule
    for (const rule of robotsRules.rules) {
      // Simple prefix match — handles most real-world robots.txt patterns.
      // Wildcard (*) and end-of-string ($) patterns from the spec are rare
      // and not worth the complexity for a QA crawler.
      if (path.startsWith(rule.pattern)) {
        return rule.allow;
      }
    }
    return true; // no matching rule = allowed
  } catch { return true; }
}

// ── sitemap.xml parsing ──────────────────────────────────────────────────────

/**
 * Extract URLs from a sitemap XML string.
 *
 * Handles both `<urlset>` (leaf sitemap) and `<sitemapindex>` (index pointing
 * to child sitemaps). Uses regex extraction instead of a full XML parser to
 * avoid adding a dependency.
 *
 * @param {string} xml — raw sitemap XML content
 * @returns {{ urls: string[], childSitemaps: string[] }}
 */
export function parseSitemapXml(xml) {
  const urls = [];
  const childSitemaps = [];

  // Extract <loc> values from <url> entries (leaf sitemap)
  const urlLocRe = /<url>\s*<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let match;
  while ((match = urlLocRe.exec(xml)) !== null) {
    const loc = match[1].trim();
    if (loc.startsWith("http")) urls.push(loc);
  }

  // Extract <loc> values from <sitemap> entries (sitemap index)
  const sitemapLocRe = /<sitemap>\s*<loc>\s*([^<]+?)\s*<\/loc>/gi;
  while ((match = sitemapLocRe.exec(xml)) !== null) {
    const loc = match[1].trim();
    if (loc.startsWith("http")) childSitemaps.push(loc);
  }

  return { urls, childSitemaps };
}

/**
 * Fetch and parse sitemap URLs from a base URL.
 *
 * Tries URLs declared in robots.txt `Sitemap:` directives first, then falls
 * back to the conventional `/sitemap.xml` location. Follows one level of
 * sitemap index indirection.
 *
 * @param {string} baseUrl — site origin
 * @param {string[]} [declaredSitemaps] — Sitemap URLs from robots.txt
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 * @param {number} [opts.maxUrls=200] — cap to avoid memory issues on huge sitemaps
 * @returns {Promise<string[]>} — deduplicated list of page URLs
 */
export async function loadSitemapUrls(baseUrl, declaredSitemaps = [], { timeoutMs = 5000, maxUrls = 200 } = {}) {
  const origin = new URL(baseUrl).origin;
  const sitemapUrls = declaredSitemaps.length > 0
    ? [...declaredSitemaps]
    : [`${origin}/sitemap.xml`];

  const allUrls = new Set();

  for (const sitemapUrl of sitemapUrls) {
    if (allUrls.size >= maxUrls) break;
    // Skip gzipped sitemaps — would require zlib
    if (sitemapUrl.endsWith(".gz")) continue;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(sitemapUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Sentri/1.0)" },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const xml = await res.text();
      const { urls, childSitemaps } = parseSitemapXml(xml);

      for (const u of urls) {
        if (allUrls.size >= maxUrls) break;
        allUrls.add(u);
      }

      // Follow one level of sitemap index
      for (const childUrl of childSitemaps) {
        if (allUrls.size >= maxUrls) break;
        if (childUrl.endsWith(".gz")) continue;
        try {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), timeoutMs);
          const childRes = await fetch(childUrl, {
            signal: c.signal,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; Sentri/1.0)" },
          });
          clearTimeout(t);
          if (!childRes.ok) continue;
          const childXml = await childRes.text();
          const { urls: childPageUrls } = parseSitemapXml(childXml);
          for (const u of childPageUrls) {
            if (allUrls.size >= maxUrls) break;
            allUrls.add(u);
          }
        } catch { /* skip unreachable child sitemap */ }
      }
    } catch { /* skip unreachable sitemap */ }
  }

  return [...allUrls];
}
