import test from "node:test";
import assert from "node:assert/strict";
import { aiRateLimit, _internal } from "../src/middleware/aiRateLimit.js";

test("isAiRoute allowlist matches configured POST routes", () => {
  const mk = (method, originalUrl) => ({ method, originalUrl });
  assert.equal(_internal.isAiRoute(mk("POST", "/api/v1/chat")), true);
  assert.equal(_internal.isAiRoute(mk("POST", "/api/v1/tests/generate")), true);
  assert.equal(_internal.isAiRoute(mk("POST", "/api/v1/projects/p1/crawl")), true);
  assert.equal(_internal.isAiRoute(mk("POST", "/api/v1/tests/t1/regenerate")), true);
  assert.equal(_internal.isAiRoute(mk("POST", "/api/v1/settings/agent-roles/author/test")), true);
  assert.equal(_internal.isAiRoute(mk("GET", "/api/v1/chat")), false);
  assert.equal(_internal.isAiRoute(mk("POST", "/api/v1/health")), false);
});

test("middleware bypasses non-AI routes", async () => {
  const mw = aiRateLimit();
  let nextCalls = 0;
  await mw({ method: "GET", originalUrl: "/api/v1/projects", workspaceId: "w1" }, {}, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
});
