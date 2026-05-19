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

  console.log("server-coverage-proxy.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
