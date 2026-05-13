/**
 * @module pipeline/impactAnalysis
 * @description Pure helpers for mapping git changed files to impacted tests.
 */

const ROUTE_FILE_EXT_RE = /\.(jsx?|tsx?|vue|svelte|astro)$/i;
const NON_ROUTE_FILE_RE = new RegExp(
  // Folders that never produce user-facing routes. `backend|server|api` excludes
  // Node server code in monorepos (e.g. `backend/src/routes/trigger.js`) which
  // otherwise hits the `routes` anchor below and emits a bogus `/trigger`
  // prefix. Frontend-ish frameworks that use `pages/api/` for serverless
  // handlers (Next.js) should rely on the `routeMap` override.
  String.raw`(^|/)(docs?|migrations?|config|scripts?|tests?|__tests__|components?|backend|server|api)(/|$)`
    + String.raw`|(^|/)(package(-lock)?\.json|vite\.config\.|webpack\.config\.|rollup\.config\.|eslint\.|prettier\.)`,
  "i",
);
const ROUTE_SUFFIX_RE = /(page|route|view|screen|component)$/i;
const INDEX_FILE_RE = /^index\.[jt]sx?$/i;

function normalizeList(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((v) => String(v || "").trim()).filter(Boolean))];
}

function normalizePathname(value) {
  if (!value) return "";
  try {
    return new URL(value).pathname || "/";
  } catch {
    const raw = String(value).trim();
    if (!raw) return "";
    return raw.startsWith("/") ? raw : `/${raw}`;
  }
}

function trimRouteToken(token) {
  return String(token || "")
    .replace(/\.[^.]+$/, "")
    .replace(ROUTE_SUFFIX_RE, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

function expandRouteMap(routeMap, file) {
  if (!routeMap || typeof routeMap !== "object" || Array.isArray(routeMap)) return [];
  const out = [];
  for (const [pattern, urls] of Object.entries(routeMap)) {
    const p = String(pattern || "");
    if (!p) continue;
    // Match strategy: exact path equality OR path-prefix on a `/`-boundary.
    // The earlier `file.includes(p)` clause silently widened scope — a key
    // like `"app"` matched every path containing the substring `app`
    // (e.g. `backend/src/middleware/appSetup.js`), and `"src"` matched the
    // whole repo. Drop substring matching and require an explicit path
    // boundary so routeMap entries behave as scoped overrides.
    const prefix = p.endsWith("/") ? p : `${p}/`;
    const matches = file === p || file.startsWith(prefix);
    if (!matches) continue;
    const list = Array.isArray(urls) ? urls : [urls];
    out.push(...list.map(normalizePathname).filter(Boolean));
  }
  return out;
}

/**
 * Derive URL path prefixes that are likely affected by a list of changed files.
 *
 * @param {string[]} changedFiles
 * @param {Object} [routeMap]
 * @returns {string[]}
 */
export function routePrefixesForChangedFiles(changedFiles, routeMap = {}) {
  const prefixes = new Set();
  for (const file of normalizeList(changedFiles)) {
    for (const mapped of expandRouteMap(routeMap, file)) prefixes.add(mapped);
    if (!ROUTE_FILE_EXT_RE.test(file) || NON_ROUTE_FILE_RE.test(file)) continue;

    const parts = file.split("/").filter(Boolean);
    const srcIdx = parts.findIndex((p) => ["src", "app", "pages", "routes"].includes(p));
    const routeParts = parts.slice(Math.max(0, srcIdx + 1));
    const stopIdx = routeParts.findIndex((p) => ["pages", "routes", "app"].includes(p));
    const scoped = stopIdx >= 0 ? routeParts.slice(stopIdx + 1) : routeParts;
    const filename = scoped.at(-1) || parts.at(-1) || "";
    const withoutFile = INDEX_FILE_RE.test(filename) ? scoped.slice(0, -1) : scoped;
    const tokens = withoutFile.map(trimRouteToken).filter((t) => t && !t.startsWith("[") && !t.startsWith("("));
    if (tokens.length > 0) {
      prefixes.add(`/${tokens.join("/")}`);
      if (!INDEX_FILE_RE.test(filename) && tokens.length > 1) prefixes.add(`/${tokens.slice(0, -1).join("/")}`);
    }
  }
  return [...prefixes].sort();
}

function testSourcePath(test) {
  return normalizePathname(test?.sourceUrl || test?.url || "");
}

function sourceMatches(pathname, prefixes) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}

/**
 * Resolve the subset of approved tests impacted by git-file and crawl-page diffs.
 *
 * @param {Object} args
 * @param {Object[]} args.tests
 * @param {string[]|null|undefined} [args.changedFiles]
 * @param {string[]} [args.changedPages]
 * @param {Object} [args.routeMap]
 * @returns {{ impactedTestIds: string[], fallbackReason: string|null, routePrefixes: string[] }}
 */
export function computeImpactedTests({ tests, changedFiles, changedPages = [], routeMap = {} }) {
  const allIds = normalizeList((tests || []).map((t) => t?.id));
  const fileList = normalizeList(changedFiles);
  const pagePrefixes = normalizeList(changedPages).map(normalizePathname).filter(Boolean);
  const hasExplicitFiles = Array.isArray(changedFiles);

  if (!hasExplicitFiles || fileList.length === 0) {
    return { impactedTestIds: allIds, fallbackReason: "no_changed_files", routePrefixes: [] };
  }

  const routePrefixes = routePrefixesForChangedFiles(fileList, routeMap);
  // Early-return only when BOTH signals are empty. The crawl-diff signal from
  // AUTO-002 (`pagePrefixes`) is an independent source of impact — a CI
  // trigger with `changedFiles: ["styles/global.css"]` (no route-mappable
  // files) but a known `/account` page change from a prior crawl should still
  // run the `/account` tests. Returning `no_impact` here without consulting
  // `pagePrefixes` silently drops that signal.
  if (routePrefixes.length === 0 && pagePrefixes.length === 0) {
    return { impactedTestIds: [], fallbackReason: "no_impact", routePrefixes };
  }
  const combinedPrefixes = [...new Set([...routePrefixes, ...pagePrefixes])];

  const impacted = [];
  for (const test of tests || []) {
    const pathname = testSourcePath(test);
    if (pathname && sourceMatches(pathname, combinedPrefixes)) impacted.push(test.id);
  }

  return {
    impactedTestIds: impacted,
    fallbackReason: impacted.length === 0 ? "no_impact" : null,
    routePrefixes,
  };
}
