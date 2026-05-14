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

const fixture = Array.from({ length: 100 }, (_, i) => ({ testId: `P-${i}`, status: "failed", error: `Error ${i % 8}`, sourceUrl: `https://a.example.com/path/${i % 4}` }));
const start = performance.now();
clusterFailures({ results: fixture });
const elapsed = performance.now() - start;
assert.ok(elapsed < 100, `expected <100ms, got ${elapsed}`);

console.log("failure-clusterer.test.js passed");
