import assert from "node:assert/strict";
import test from "node:test";
import { setupTestEnvironment } from "./helpers/test-base.js";

setupTestEnvironment();

const repo = await import("../src/database/repositories/agentThreadStateRepo.js");

test("agent thread blackboard setKey/get", () => {
  const out = repo.setKey("t1", "ws1", "a", 1);
  assert.equal(out.state.a, 1);
  assert.equal(out.version, 1);
  const out2 = repo.setKey("t1", "ws1", "b", 2);
  assert.equal(out2.state.b, 2);
  assert.equal(out2.version, 2);
});

test("agent thread blackboard CAS update + mismatch", () => {
  const first = repo.casUpdate("t2", "ws1", 0, (s) => ({ ...s, ok: true }));
  assert.equal(first.version, 1);
  const second = repo.casUpdate("t2", "ws1", 1, (s) => ({ ...s, ok: false }));
  assert.equal(second.state.ok, false);
  assert.throws(() => repo.casUpdate("t2", "ws1", 1, (s) => s), /version mismatch/);
});

test("agent thread blackboard size cap", () => {
  process.env.AGENT_THREAD_STATE_MAX_BYTES = "128";
  assert.throws(() => repo.setKey("t3", "ws1", "blob", "x".repeat(300)), /size budget/);
  delete process.env.AGENT_THREAD_STATE_MAX_BYTES;
});
