import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { clusterFailures } from "../src/pipeline/failureClusterer.js";

const same = Array.from({ length: 10 }, (_, i) => ({ testId: `T-${i}`, status: "failed", error: "Error: ECONNREFUSED https://api.example.com/auth", sourceUrl: "https://api.example.com/auth/login", selector: "#login-button" }));
const c1 = clusterFailures({ results: same });
assert.equal(c1.length, 1);
assert.equal(c1[0].size, 10);

const distinct = [
  { testId: "a", status: "failed", error: "Error A", sourceUrl: "https://a.com/x" },
  { testId: "b", status: "failed", error: "Error B", sourceUrl: "https://b.com/x" },
];
assert.equal(clusterFailures({ results: distinct }).length, 2);

const urlPrefix = clusterFailures({ results: [
  { testId: "u1", status: "failed", error: "Error A", sourceUrl: "https://app.example.com/auth/login" },
  { testId: "u2", status: "failed", error: "Error A", sourceUrl: "https://app.example.com/auth/callback" },
]});
assert.equal(urlPrefix.length, 1);

const selectorSimilar = clusterFailures({ results: [
  { testId: "s1", status: "failed", error: "Error A", selector: "button[type='submit']" },
  { testId: "s2", status: "failed", error: "Error A", selector: "button[type=submit]" },
]});
assert.equal(selectorSimilar.length, 1);

assert.deepEqual(clusterFailures({ results: [{ testId: "p", status: "passed" }] }), []);

// AUTO-010 — affectedTestIds must be deduplicated. A data-driven test with
// 3 failing iterations contributes size=3 but only one entry in affectedTestIds.
const iterations = clusterFailures({ results: [
  { testId: "T-1", status: "failed", error: "Error A", sourceUrl: "https://a.com/x" },
  { testId: "T-1", status: "failed", error: "Error A", sourceUrl: "https://a.com/x" },
  { testId: "T-1", status: "failed", error: "Error A", sourceUrl: "https://a.com/x" },
]});
assert.equal(iterations.length, 1);
assert.equal(iterations[0].size, 3);
assert.deepEqual(iterations[0].affectedTestIds, ["T-1"]);

// AUTO-010 — two URL-less + selector-less failures with the SAME error pattern
// fall back to error-pattern equality (acceptable for "AI provider 503" cases).
const urllessSame = clusterFailures({ results: [
  { testId: "X-1", status: "failed", error: "AI provider returned 503" },
  { testId: "X-2", status: "failed", error: "AI provider returned 503" },
]});
assert.equal(urllessSame.length, 1);
assert.equal(urllessSame[0].size, 2);

// AUTO-010 — but two URL-less failures with DIFFERENT selectors must NOT merge
// just because both lack a URL — the previous `null === null` shortcut would
// have falsely combined them on error pattern alone, bypassing the selector
// distance check. With the fix, they stay as distinct clusters.
const urllessDistinctSelectors = clusterFailures({ results: [
  { testId: "Y-1", status: "failed", error: "Error A", selector: "button[type='submit']" },
  { testId: "Y-2", status: "failed", error: "Error A", selector: "input[name='completely-different']" },
]});
assert.equal(urllessDistinctSelectors.length, 2,
  "URL-less failures with materially different selectors must remain separate clusters");

// AUTO-010 — public cluster shape must be JSON-serialisable (no Set instances).
// runRepo persists `rootCauses` via JSON.stringify on the JSON_FIELDS path;
// a leaked Set would silently serialise to `{}` and break the UI.
const serialisable = clusterFailures({ results: [
  { testId: "S-1", status: "failed", error: "Boom" },
  { testId: "S-2", status: "failed", error: "Boom" },
]});
const roundTripped = JSON.parse(JSON.stringify(serialisable));
assert.deepEqual(roundTripped, serialisable, "cluster shape must round-trip through JSON");
for (const c of serialisable) {
  assert.ok(!("_seenTestIds" in c), "internal _seenTestIds scratchpad must be stripped");
}

const fixture = Array.from({ length: 100 }, (_, i) => ({ testId: `P-${i}`, status: "failed", error: `Error ${i % 8}`, sourceUrl: `https://a.example.com/path/${i % 4}` }));
const start = performance.now();
clusterFailures({ results: fixture });
const elapsed = performance.now() - start;
// Generous budget: correctness is the point, not perf — loaded CI runners spike.
assert.ok(elapsed < 500, `expected <500ms, got ${elapsed}`);

console.log("failure-clusterer.test.js passed");
