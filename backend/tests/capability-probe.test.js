import assert from "node:assert/strict";
import { createTestRunner } from "./helpers/test-base.js";
import { capabilitiesFor } from "../src/aiProvider/modelCatalog.js";

const { test, summary } = createTestRunner();

test("capabilitiesFor returns booleans + numeric/null bounds", () => {
  const caps = capabilitiesFor("openai");
  assert.equal(typeof caps.supportsVision, "boolean");
  assert.equal(typeof caps.supportsJsonMode, "boolean");
  assert.equal(typeof caps.supportsStreaming, "boolean");
  assert.ok(caps.contextWindow == null || Number.isFinite(caps.contextWindow));
  assert.ok(caps.maxOutputTokens == null || Number.isFinite(caps.maxOutputTokens));
});

summary("Capability probe");
