import assert from "node:assert/strict";
import { computeUpstreamSkips, findDependencyCycle, topologicalSortTests } from "../src/runner/dependencyOrder.js";

function ids(rows) { return rows.map((r) => r.id); }

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

test("topologicalSortTests orders a linear chain", () => {
  const { ordered, skipped } = topologicalSortTests([
    { id: "C", dependsOn: ["B"] },
    { id: "A" },
    { id: "B", dependsOn: ["A"] },
  ]);
  assert.deepEqual(ids(ordered), ["A", "B", "C"]);
  assert.deepEqual(skipped, []);
});

test("topologicalSortTests orders diamond dependencies stably", () => {
  const { ordered } = topologicalSortTests([
    { id: "D", dependsOn: ["B", "C"] },
    { id: "B", dependsOn: ["A"] },
    { id: "C", dependsOn: ["A"] },
    { id: "A" },
    { id: "E" },
  ]);
  assert.deepEqual(ids(ordered), ["A", "B", "C", "D", "E"]);
});

test("topologicalSortTests preserves multi-root and isolated-node order", () => {
  const { ordered } = topologicalSortTests([
    { id: "A" },
    { id: "B" },
    { id: "C", dependsOn: ["A"] },
    { id: "D" },
  ]);
  assert.deepEqual(ids(ordered), ["A", "B", "C", "D"]);
});


test("topologicalSortTests treats satisfied upstream IDs as already run", () => {
  const { ordered, skipped } = topologicalSortTests([
    { id: "checkout", dependsOn: ["login-smoke"] },
    { id: "receipt", dependsOn: ["checkout"] },
  ], { satisfiedTestIds: ["login-smoke"] });
  assert.deepEqual(ids(ordered), ["checkout", "receipt"]);
  assert.deepEqual(skipped, []);
});

test("topologicalSortTests soft-skips missing upstream dependencies", () => {
  const { ordered, skipped } = topologicalSortTests([
    { id: "B", dependsOn: ["A"] },
    { id: "C", dependsOn: ["B"] },
    { id: "D" },
  ]);
  assert.deepEqual(ids(ordered), ["D"]);
  assert.deepEqual(skipped.map((r) => [r.id, r.skipReason]), [["B", "missing_upstream"], ["C", "missing_upstream"]]);
});

test("findDependencyCycle detects self, two-node, three-node, and deep cycles", () => {
  assert.deepEqual(findDependencyCycle([{ id: "A", dependsOn: ["A"] }]), ["A", "A"]);
  assert.deepEqual(findDependencyCycle([{ id: "A", dependsOn: ["B"] }, { id: "B", dependsOn: ["A"] }]), ["A", "B", "A"]);
  assert.deepEqual(findDependencyCycle([{ id: "A", dependsOn: ["B"] }, { id: "B", dependsOn: ["C"] }, { id: "C", dependsOn: ["A"] }]), ["A", "B", "C", "A"]);
  assert.deepEqual(findDependencyCycle([{ id: "A", dependsOn: ["B"] }, { id: "B", dependsOn: ["C"] }, { id: "C", dependsOn: ["D"] }, { id: "D", dependsOn: ["B"] }]), ["B", "C", "D", "B"]);
});

test("topologicalSortTests throws structured cycle errors", () => {
  assert.throws(
    () => topologicalSortTests([{ id: "A", dependsOn: ["B"] }, { id: "B", dependsOn: ["A"] }]),
    (err) => err.code === "CYCLE_DETECTED" && Array.isArray(err.path),
  );
});

test("computeUpstreamSkips cascades from a single root", () => {
  const skipped = computeUpstreamSkips([
    { id: "A" },
    { id: "B", dependsOn: ["A"] },
    { id: "C", dependsOn: ["B"] },
    { id: "D" },
  ], new Set(["A"]));
  assert.deepEqual([...skipped].sort(), ["B", "C"]);
});

test("computeUpstreamSkips handles multi-root and partial failures", () => {
  const tests = [
    { id: "A" },
    { id: "B" },
    { id: "C", dependsOn: ["A", "B"] },
    { id: "D", dependsOn: ["C"] },
    { id: "E", dependsOn: ["B"] },
  ];
  assert.deepEqual([...computeUpstreamSkips(tests, ["A"])].sort(), ["C", "D"]);
  assert.deepEqual([...computeUpstreamSkips(tests, ["A", "B"])].sort(), ["C", "D", "E"]);
});

if (process.exitCode) process.exit(process.exitCode);
