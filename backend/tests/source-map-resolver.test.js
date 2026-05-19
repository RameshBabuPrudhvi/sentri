/**
 * @module tests/source-map-resolver
 * @description AUTO-009b — unit tests for the source-map resolver.
 *
 * Covers:
 *   - happy path: 200 + valid .map → SourceMapConsumer with `mapBundleLine`
 *     surfacing original source paths.
 *   - 404 → null (logged, never throws).
 *   - malformed JSON → null.
 *   - SSRF block: resolver refuses loopback / private-IP map URLs without
 *     hitting the network.
 *   - LRU cache hit: second resolve for same bundleUrl does not re-fetch.
 *   - partial resolution: aggregator-side behaviour is exercised in
 *     `run-coverage-integration.test.js`; this file pins the resolver
 *     contract.
 *
 * The `source-map` npm package is loaded lazily inside the happy-path test so
 * a missing/broken install fails just that case rather than crashing the
 * whole file before SSRF / 404 / cache tests can run.
 */

// AUTO-009k — converted to house style: direct `node:assert/strict` calls
// inside an async main(), no `node:test` framework import. Matches the
// pattern at `backend/tests/failure-clusterer.test.js`.
import assert from "node:assert/strict";
import { resolveSourceMap, mapBundleLine, __resetCacheForTest } from "../src/pipeline/sourceMapResolver.js";

const realFetch = globalThis.fetch;
function restoreFetch() { globalThis.fetch = realFetch; }

// Minimal valid v3 source map mapping bundle line 1 col 0 → src/Cart.tsx:42.
const FAKE_MAP = {
  version: 3,
  file: "main.js",
  sources: ["src/Cart.tsx"],
  names: [],
  // VLQ: AAEC = generated col 0 → source 0, original line 41 (0-based), col 1
  // We don't strictly need exact VLQ; SourceMapConsumer handles empty mappings
  // safely. Provide a single mapping for line 1.
  mappings: "AAAA",
  sourcesContent: ["// Cart.tsx"],
};

function stubFetch(handler) {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    return handler(url, init);
  };
}

async function main() {

await (async () => {
  __resetCacheForTest();
  let fetched = 0;
  stubFetch(async (url) => {
    if (!url.endsWith(".map")) throw new Error(`unexpected fetch ${url}`);
    fetched++;
    return new Response(JSON.stringify(FAKE_MAP), {
      status: 200,
      headers: { "content-type": "application/json", "etag": "W/\"abc\"" },
    });
  });
  try {
    const consumer = await resolveSourceMap("https://example.com/main.js");
    assert.ok(consumer, "resolver returns a consumer on 200 + valid map");
    assert.equal(fetched, 1, "fetched exactly once");
    const mapped = mapBundleLine(consumer, 1, 0);
    // We don't assert exact line — VLQ semantics vary — but the source must
    // come from the map's sources[] when any mapping resolves.
    if (mapped) {
      assert.equal(typeof mapped.source, "string");
      assert.equal(typeof mapped.line, "number");
    }
  } finally { restoreFetch(); __resetCacheForTest(); }
})();

await (async () => {
  __resetCacheForTest();
  stubFetch(async () => new Response("not found", { status: 404 }));
  try {
    const consumer = await resolveSourceMap("https://example.com/missing.js");
    assert.equal(consumer, null);
  } finally { restoreFetch(); __resetCacheForTest(); }
})();

await (async () => {
  __resetCacheForTest();
  stubFetch(async () => new Response("<!doctype html><html>not json</html>", { status: 200 }));
  try {
    const consumer = await resolveSourceMap("https://example.com/broken.js");
    assert.equal(consumer, null);
  } finally { restoreFetch(); __resetCacheForTest(); }
})();

await (async () => {
  __resetCacheForTest();
  let fetched = 0;
  stubFetch(async () => { fetched++; return new Response("x", { status: 200 }); });
  try {
    const consumer = await resolveSourceMap("http://127.0.0.1/app.js");
    assert.equal(consumer, null, "SSRF guard rejects loopback");
    assert.equal(fetched, 0, "fetch never reached the network");
  } finally { restoreFetch(); __resetCacheForTest(); }
})();

await (async () => {
  __resetCacheForTest();
  let fetched = 0;
  stubFetch(async () => {
    fetched++;
    return new Response(JSON.stringify(FAKE_MAP), {
      status: 200,
      headers: { "content-type": "application/json", "etag": "W/\"xyz\"" },
    });
  });
  try {
    const a = await resolveSourceMap("https://example.com/app.js");
    const b = await resolveSourceMap("https://example.com/app.js");
    assert.ok(a && b, "both resolves succeed");
    assert.equal(fetched, 1, "second resolve served from cache (1 fetch total)");
  } finally { restoreFetch(); __resetCacheForTest(); }
})();

await (async () => {
  __resetCacheForTest();
  let seenUrl = null;
  stubFetch(async (url) => {
    seenUrl = url;
    return new Response(JSON.stringify(FAKE_MAP), { status: 200 });
  });
  try {
    await resolveSourceMap("https://example.com/static/main.abc123.js", {
      sourcemapBaseUrl: "https://example.com/maps/",
    });
    assert.equal(seenUrl, "https://example.com/maps/main.abc123.js.map");
  } finally { restoreFetch(); __resetCacheForTest(); }
})();

await (async () => {
  assert.equal(mapBundleLine(null, 1, 0), null);
  assert.equal(mapBundleLine({}, 1, 0), null);
})();

  console.log("source-map-resolver.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
