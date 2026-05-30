import assert from "node:assert/strict";
import { findDependencyCycle } from "../src/utils/dependencyGraph.js";

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

test("findDependencyCycle returns null for acyclic graphs", () => {
  assert.equal(findDependencyCycle([
    { id: "A" },
    { id: "B", dependsOn: ["A"] },
    { id: "C", dependsOn: ["B"] },
  ]), null);
});

test("findDependencyCycle matches backend path shape", () => {
  assert.deepEqual(findDependencyCycle([
    { id: "A", dependsOn: ["B"] },
    { id: "B", dependsOn: ["C"] },
    { id: "C", dependsOn: ["A"] },
  ]), ["A", "B", "C", "A"]);
});

if (process.exitCode) process.exit(process.exitCode);
