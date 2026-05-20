/**
 * @module tests/server-coverage-proxy
 * @description AUTO-009h — unit tests for the server-side coverage helper.
 *
 * Covers `snapshotServerCoverage` happy path / 404 / malformed JSON / SSRF
 * block + file-watch mode, and `diffServerCoverage` shape (added stmt /
 * branch / function counting). Hermetic — stubs `globalThis.fetch` and
 * uses an OS tmpdir for file mode.
 *
 * House style — direct `node:assert/strict`, async main, match
 * `failure-clusterer.test.js`.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { snapshotServerCoverage, diffServerCoverage } from "../src/pipeline/serverCoverageProxy.js";

const realFetch = globalThis.fetch;
function restoreFetch() { globalThis.fetch = realFetch; }
function stubFetch(handler) {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    return handler(url, init);
  };
}

const FAKE_COVERAGE = {
  "/app/src/server.js": {
    path: "/app/src/server.js",
    statementMap: { 0: {}, 1: {}, 2: {} },
    s: { 0: 1, 1: 0, 2: 0 },
    fnMap: { 0: { name: "handler" } },
    f: { 0: 1 },
    branchMap: { 0: { type: "if" } },
    b: { 0: [1, 0] },
  },
};

async function main() {

await (async () => {
  stubFetch(async (url) => {
    if (!url.includes("__coverage__")) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(FAKE_COVERAGE), { status: 200 });
  });
  try {
    const cov = await snapshotServerCoverage("https://example.com/__coverage__");
    assert.ok(cov, "happy path returns coverage object");
    assert.equal(cov["/app/src/server.js"].path, "/app/src/server.js");
  } finally { restoreFetch(); }
})();

await (async () => {
  stubFetch(async () => new Response("not found", { status: 404 }));
  try {
    const cov = await snapshotServerCoverage("https://example.com/__coverage__");
    assert.equal(cov, null, "404 returns null");
  } finally { restoreFetch(); }
})();

await (async () => {
  stubFetch(async () => new Response("<!doctype html>not json", { status: 200 }));
  try {
    const cov = await snapshotServerCoverage("https://example.com/__coverage__");
    assert.equal(cov, null, "malformed JSON returns null");
  } finally { restoreFetch(); }
})();

await (async () => {
  let fetched = 0;
  stubFetch(async () => { fetched++; return new Response("x", { status: 200 }); });
  try {
    const cov = await snapshotServerCoverage("http://127.0.0.1/__coverage__");
    assert.equal(cov, null, "SSRF guard rejects loopback");
    assert.equal(fetched, 0, "fetch never reached the network");
  } finally { restoreFetch(); }
})();

await (async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sentri-cov-"));
  const file = path.join(dir, "coverage.json");
  await fs.writeFile(file, JSON.stringify(FAKE_COVERAGE), "utf-8");
  const cov = await snapshotServerCoverage(`file://${file}`);
  assert.ok(cov, "file:// mode reads + parses");
  assert.equal(cov["/app/src/server.js"].path, "/app/src/server.js");
  await fs.rm(dir, { recursive: true, force: true });
})();

await (async () => {
  // AUTO-009h hardening — file:// path with `..` segments must be rejected
  // at runtime even when the route layer somehow allowed it (DB tamper,
  // env change between PATCH and runtime). Defense-in-depth — see
  // `routes/projects.js` for the PATCH-time check.
  const cov = await snapshotServerCoverage("file:///var/coverage/../etc/passwd");
  assert.equal(cov, null, "`..` traversal rejected at runtime");
})();

await (async () => {
  // AUTO-009h hardening — relative file:// paths rejected at runtime.
  // The route layer rejects these at PATCH time, but the runtime check
  // catches the case where an existing DB row predates the validation.
  const cov = await snapshotServerCoverage("file://./relative/path.json");
  assert.equal(cov, null, "relative file:// path rejected at runtime");
})();

await (async () => {
  // AUTO-009h hardening — `COVERAGE_FILE_PATH_PREFIX` env-based allowlist.
  // When set, only paths matching one of the configured prefixes succeed.
  // Real file at the safe path → reads fine. Outside-prefix path → null.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sentri-cov-prefix-"));
  const safeFile = path.join(dir, "coverage.json");
  await fs.writeFile(safeFile, JSON.stringify(FAKE_COVERAGE), "utf-8");
  const originalPrefix = process.env.COVERAGE_FILE_PATH_PREFIX;
  try {
    process.env.COVERAGE_FILE_PATH_PREFIX = dir;
    const allowed = await snapshotServerCoverage(`file://${safeFile}`);
    assert.ok(allowed, "path within prefix is allowed");
    const blocked = await snapshotServerCoverage("file:///etc/hostname");
    assert.equal(blocked, null, "path outside prefix is rejected");
  } finally {
    if (originalPrefix === undefined) delete process.env.COVERAGE_FILE_PATH_PREFIX;
    else process.env.COVERAGE_FILE_PATH_PREFIX = originalPrefix;
    await fs.rm(dir, { recursive: true, force: true });
  }
})();

await (async () => {
  // diffServerCoverage — `after` exercises stmt 1 and arm 1 that were 0
  // in `before`. Result should report `addedStatements: 1`,
  // `addedBranches: 1`, `addedFunctions: 0`.
  const before = {
    "/app/src/server.js": {
      s: { 0: 1, 1: 0, 2: 0 }, f: { 0: 1 }, b: { 0: [1, 0] },
    },
  };
  const after = {
    "/app/src/server.js": {
      s: { 0: 1, 1: 1, 2: 0 }, f: { 0: 1 }, b: { 0: [1, 1] },
    },
  };
  const diff = diffServerCoverage(before, after);
  const file = diff["/app/src/server.js"];
  assert.ok(file, "diff includes the file with new coverage");
  assert.equal(file.addedStatements, 1, "1 new statement covered");
  assert.equal(file.addedBranches, 1, "1 new branch arm covered");
  assert.equal(file.addedFunctions, 0, "function already covered before");
  assert.equal(file.totalStatements, 3);
  assert.equal(file.totalBranches, 2);
  assert.equal(file.totalFunctions, 1);
})();

await (async () => {
  // Null `before` (first-ever snapshot) → everything covered in `after`
  // shows up as added.
  const after = { "/x.js": { s: { 0: 1 }, f: {}, b: {} } };
  const diff = diffServerCoverage(null, after);
  assert.equal(diff["/x.js"].addedStatements, 1);
})();

await (async () => {
  // No new coverage → empty diff (file omitted entirely).
  const cov = { "/x.js": { s: { 0: 1 }, f: {}, b: {} } };
  const diff = diffServerCoverage(cov, cov);
  assert.deepEqual(diff, {}, "no new coverage → empty diff");
})();

await (async () => {
  // AUTO-009h — aggregator end-to-end with stub resolver that rewrites
  // `/app/dist/server.js` → `src/server.ts`. Verifies the new code path
  // at coverageAggregator.js — server paths get source-map-resolved
  // when a resolver is supplied AND the path matches the `.js` regex.
  const { aggregateRunCoverage } = await import("../src/pipeline/coverageAggregator.js");
  const stubResolver = {
    resolve: async (p) => (p === "/app/dist/server.js" ? { _stub: true } : null),
    mapLine: (consumer, _line) => (consumer?._stub ? { source: "src/server.ts" } : null),
  };
  const results = [{
    testId: "T1", isApiTest: true,
    serverCoverage: {
      "/app/dist/server.js": {
        addedStatements: 5, addedBranches: 0, addedFunctions: 1,
        totalStatements: 10, totalBranches: 2, totalFunctions: 1,
      },
    },
  }];
  const summary = await aggregateRunCoverage(results, { sutOrigin: "https://api.example.com", resolver: stubResolver });
  const serverRow = (summary.topUncoveredFiles || []).find((f) => f.layer === "server");
  assert.ok(serverRow, "server-layer row exists");
  assert.equal(serverRow.file, "src/server.ts", "path rewritten via resolver");
  assert.equal(serverRow.bundleUrl, "/app/dist/server.js", "original c8 path preserved on bundleUrl");
  assert.equal(serverRow.uncoveredLines, 5, "10 total - 5 added = 5 uncovered");
  assert.equal(summary.serverLayer, true, "serverLayer flag set");
})();

await (async () => {
  // AUTO-009h — when c8 emits already-resolved `.ts` paths, the
  // resolver branch never fires (regex doesn't match `.ts`). Verifies
  // `bundleUrl` stays null and the path passes through untouched, so
  // pre-existing operators using c8 --source-map see byte-identical
  // shape.
  const { aggregateRunCoverage } = await import("../src/pipeline/coverageAggregator.js");
  let resolverCalled = false;
  const stubResolver = {
    resolve: async () => { resolverCalled = true; return null; },
    mapLine: () => null,
  };
  const results = [{
    testId: "T1", isApiTest: true,
    serverCoverage: {
      "/app/src/server.ts": {
        addedStatements: 3, addedBranches: 0, addedFunctions: 0,
        totalStatements: 8, totalBranches: 0, totalFunctions: 0,
      },
    },
  }];
  const summary = await aggregateRunCoverage(results, { sutOrigin: "https://api.example.com", resolver: stubResolver });
  assert.equal(resolverCalled, false, "resolver skipped for .ts paths");
  const serverRow = (summary.topUncoveredFiles || []).find((f) => f.layer === "server");
  assert.equal(serverRow.file, "/app/src/server.ts", "ts path passes through");
  assert.equal(serverRow.bundleUrl, null, "no bundleUrl when path was not rewritten");
})();

  console.log("server-coverage-proxy.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
