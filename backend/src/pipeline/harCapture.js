/**
 * @module pipeline/harCapture
 * @description Captures API traffic during crawl/exploration and produces a
 * structured summary of discovered endpoints for API test generation.
 *
 * Attaches Playwright request/response listeners to a `BrowserContext` and
 * records every same-origin fetch/XHR call. After crawling completes, the
 * captured entries are deduplicated, grouped by endpoint pattern, and
 * summarised into an `ApiEndpoint[]` array that the AI prompt can consume.
 *
 * ### What is captured
 * - Method, URL path, query params, request headers (safe subset)
 * - Request body (JSON only, truncated to 2 KB)
 * - Response status, content-type, body (JSON only, truncated to 2 KB)
 * - Timing (duration ms)
 *
 * ### What is filtered out
 * - Static assets (images, fonts, CSS, JS bundles, sourcemaps)
 * - Third-party origins (analytics, CDNs, ads)
 * - Duplicate endpoint+method combinations (keeps first + last seen)
 *
 * ### Exports
 * - {@link createHarCapture} — attach to a BrowserContext, returns collector
 * - {@link summariseApiEndpoints} — deduplicate + group captured entries
 */

// File extensions / path segments that indicate static assets — never API calls
const STATIC_PATTERNS = [
  /\.(js|mjs|css|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map|webp|avif)(\?|$)/i,
  /\/(fonts|images|assets|static|_next\/static|__webpack)\//i,
  /^data:/,
  /\/favicon/i,
  /\/manifest\.json$/i,
];

// Request headers safe to include in the prompt (no auth tokens / cookies)
const SAFE_HEADERS = new Set([
  "content-type", "accept", "x-requested-with", "origin", "referer",
]);

// Max body size to capture (keeps prompt tokens bounded)
const MAX_BODY_CHARS = 2048;

function isStaticAsset(url) {
  return STATIC_PATTERNS.some(re => re.test(url));
}

function truncate(str, max = MAX_BODY_CHARS) {
  if (!str || str.length <= max) return str || "";
  return str.slice(0, max) + `… [truncated, ${str.length} total chars]`;
}

function safeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (SAFE_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Normalise a URL path into a pattern by replacing numeric/UUID segments
 * with `:id` placeholders. This groups `/api/users/123` and `/api/users/456`
 * into the same endpoint pattern `/api/users/:id`.
 *
 * @param {string} pathname
 * @returns {string}
 */
function normalisePathPattern(pathname) {
  return pathname
    .split("/")
    .map(seg => {
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8,}$/i.test(seg)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return ":id";
      return seg;
    })
    .join("/");
}

/**
 * Attach API traffic capture to a Playwright BrowserContext.
 *
 * Call `capture.detach()` when done to stop listening. Then call
 * `capture.getEntries()` to retrieve all captured API calls.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} appOrigin — the project URL origin (only same-origin calls captured)
 * @returns {{ detach: () => void, getEntries: () => HarEntry[] }}
 */
export function createHarCapture(context, appOrigin) {
  const entries = [];
  const pending = new Map(); // url+method → entry (for matching responses)

  let origin;
  try { origin = new URL(appOrigin).origin; } catch { origin = appOrigin; }

  function onRequest(request) {
    try {
      const url = request.url();
      if (isStaticAsset(url)) return;

      let parsed;
      try { parsed = new URL(url); } catch { return; }
      if (parsed.origin !== origin) return;

      const method = request.method();
      const resourceType = request.resourceType();
      // Only capture fetch/xhr — skip document, stylesheet, image, etc.
      if (!["fetch", "xhr"].includes(resourceType)) return;

      let reqBody = null;
      try {
        const postData = request.postData();
        if (postData) reqBody = truncate(postData);
      } catch { /* no body */ }

      const entry = {
        method,
        url,
        pathname: parsed.pathname,
        query: parsed.search || "",
        requestHeaders: safeHeaders(request.headers()),
        requestBody: reqBody,
        status: null,
        responseHeaders: {},
        responseBody: null,
        contentType: null,
        durationMs: null,
        startTime: Date.now(),
        pageUrl: null,
      };

      // Try to capture which page triggered this request
      try {
        const frame = request.frame();
        if (frame) entry.pageUrl = frame.url();
      } catch { /* frame may be detached */ }

      const key = `${method}:${url}`;
      pending.set(key, entry);
      entries.push(entry);
    } catch { /* swallow — never break the crawl */ }
  }

  async function onResponse(response) {
    try {
      const url = response.url();
      const method = response.request().method();
      const key = `${method}:${url}`;
      const entry = pending.get(key);
      if (!entry) return;
      pending.delete(key);

      entry.status = response.status();
      entry.durationMs = Date.now() - entry.startTime;

      const ct = (response.headers()["content-type"] || "").toLowerCase();
      entry.contentType = ct;
      entry.responseHeaders = safeHeaders(response.headers());

      // Only capture JSON response bodies — HTML/binary is noise for API tests
      if (ct.includes("json")) {
        try {
          const body = await response.text().catch(() => "");
          entry.responseBody = truncate(body);
        } catch { /* body unavailable */ }
      }
    } catch { /* swallow */ }
  }

  // Attach to context so ALL pages in the context are captured
  context.on("request", onRequest);
  context.on("response", onResponse);

  return {
    detach() {
      context.removeListener("request", onRequest);
      context.removeListener("response", onResponse);
    },
    getEntries() {
      return entries;
    },
  };
}

/**
 * Deduplicate and summarise captured HAR entries into API endpoint descriptors.
 *
 * Groups entries by `METHOD + normalised path pattern`, keeps the first and
 * last example for each group (so the AI sees both the shape and variation),
 * and produces a compact summary suitable for the API test prompt.
 *
 * @param {HarEntry[]} entries — raw entries from createHarCapture
 * @returns {ApiEndpoint[]} — deduplicated endpoint summaries
 *
 * @typedef {Object} ApiEndpoint
 * @property {string}   method       — HTTP method (GET, POST, etc.)
 * @property {string}   pathPattern  — normalised path (e.g. `/api/users/:id`)
 * @property {string[]} exampleUrls  — 1–2 concrete URLs observed
 * @property {number[]} statuses     — unique status codes observed
 * @property {string}   contentType  — response content-type
 * @property {string|null} requestBodyExample — first observed request body (JSON)
 * @property {string|null} responseBodyExample — first observed response body (JSON)
 * @property {number}   callCount    — how many times this endpoint was hit
 * @property {number}   avgDurationMs
 * @property {string[]} pageUrls     — which pages triggered this endpoint
 */
export function summariseApiEndpoints(entries) {
  if (!entries || entries.length === 0) return [];

  // Group by METHOD + normalised path
  const groups = new Map();

  for (const e of entries) {
    const pattern = normalisePathPattern(e.pathname);
    const key = `${e.method} ${pattern}`;

    if (!groups.has(key)) {
      groups.set(key, {
        method: e.method,
        pathPattern: pattern,
        exampleUrls: [],
        statuses: new Set(),
        contentType: e.contentType || "",
        requestBodyExample: null,
        responseBodyExample: null,
        durations: [],
        pageUrls: new Set(),
        callCount: 0,
      });
    }

    const g = groups.get(key);
    g.callCount++;
    if (g.exampleUrls.length < 2 && !g.exampleUrls.includes(e.url)) {
      g.exampleUrls.push(e.url);
    }
    if (e.status) g.statuses.add(e.status);
    if (e.durationMs) g.durations.push(e.durationMs);
    if (e.pageUrl) g.pageUrls.add(e.pageUrl);
    if (!g.requestBodyExample && e.requestBody) g.requestBodyExample = e.requestBody;
    if (!g.responseBodyExample && e.responseBody) g.responseBodyExample = e.responseBody;
    if (!g.contentType && e.contentType) g.contentType = e.contentType;
  }

  // Convert to array and sort by call count (most-used endpoints first)
  return Array.from(groups.values())
    .map(g => ({
      method: g.method,
      pathPattern: g.pathPattern,
      exampleUrls: g.exampleUrls,
      statuses: [...g.statuses].sort(),
      contentType: g.contentType,
      requestBodyExample: g.requestBodyExample,
      responseBodyExample: g.responseBodyExample,
      callCount: g.callCount,
      avgDurationMs: g.durations.length
        ? Math.round(g.durations.reduce((s, d) => s + d, 0) / g.durations.length)
        : 0,
      pageUrls: [...g.pageUrls].slice(0, 3),
    }))
    .sort((a, b) => b.callCount - a.callCount)
    .slice(0, 30); // Cap at 30 endpoints to keep prompt bounded
}
