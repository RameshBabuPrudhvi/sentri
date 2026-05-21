import assert from "node:assert/strict";
import { createTestRunner } from "./helpers/test-base.js";
import { hashPrompt } from "../src/aiProvider/requestLog.js";

const { test, summary } = createTestRunner();

test("hashPrompt is deterministic sha256 hex", () => {
  const a = hashPrompt("hello");
  const b = hashPrompt("hello");
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.match(a, /^[a-f0-9]{64}$/);
});

summary("AI request log");
