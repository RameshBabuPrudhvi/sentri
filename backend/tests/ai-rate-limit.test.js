/**
 * @module tests/ai-rate-limit
 * @description Unit coverage for the MNT-015 per-workspace AI limiter.
 */

import assert from "node:assert/strict";
import { aiRateLimit } from "../src/middleware/aiRateLimit.js";

function createReq({ workspaceId = `ws-${Math.random()}`, method = "POST", role = "qa_lead" } = {}) {
  return { workspaceId, method, userRole: role, path: "/chat" };
}

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(mw, req) {
  const res = createRes();
  let nextCalled = false;
  let nextErr = null;
  await mw(req, res, (err) => { nextCalled = true; nextErr = err || null; });
  return { res, nextCalled, nextErr };
}

async function main() {
  let passed = 0;
  let failed = 0;
  async function run(name, fn) {
    try { await fn(); passed++; console.log(`  ✅  ${name}`); }
    catch (err) { failed++; console.log(`  ❌  ${name}\n      ${err.stack || err.message}`); }
  }

  await run("cost-weighted requests trip the cap", async () => {
    const mw = aiRateLimit({ cap: 15, windowSec: 60, costFn: () => 10 });
    const workspaceId = `ws-cost-${Date.now()}`;
    let out = await invoke(mw, createReq({ workspaceId }));
    assert.equal(out.nextCalled, true);
    assert.equal(out.nextErr, null);
    out = await invoke(mw, createReq({ workspaceId }));
    assert.equal(out.res.statusCode, 429);
    assert.equal(out.res.headers["retry-after"], "60");
  });

  await run("sibling workspaces use isolated buckets", async () => {
    const mw = aiRateLimit({ cap: 10, windowSec: 60, costFn: () => 10 });
    const a = `ws-a-${Date.now()}`;
    const b = `ws-b-${Date.now()}`;
    assert.equal((await invoke(mw, createReq({ workspaceId: a }))).nextCalled, true);
    assert.equal((await invoke(mw, createReq({ workspaceId: a }))).res.statusCode, 429);
    assert.equal((await invoke(mw, createReq({ workspaceId: b }))).nextCalled, true);
  });

  await run("regular (cost=1) requests share the same bucket and consume one unit each", async () => {
    // Single bucket, single cap — cost-weighting differentiates AI from
    // regular calls (10 vs 1), but both draw from the same budget. Industry
    // pattern (Vercel AI Gateway, Cursor, OpenRouter): one key, one cap.
    const mw = aiRateLimit({ cap: 2, windowSec: 60, costFn: () => 1 });
    const workspaceId = `ws-regular-${Date.now()}`;
    assert.equal((await invoke(mw, createReq({ workspaceId }))).nextCalled, true);
    assert.equal((await invoke(mw, createReq({ workspaceId }))).nextCalled, true);
    assert.equal((await invoke(mw, createReq({ workspaceId }))).res.statusCode, 429);
  });

  await run("bypasses requests without workspace scope", async () => {
    const mw = aiRateLimit({ cap: 1, costFn: () => 10 });
    const out = await invoke(mw, { method: "POST", path: "/health" });
    assert.equal(out.nextCalled, true);
    assert.equal(out.res.statusCode, 200);
  });

  await run("emits RateLimit-* headers on allow path", async () => {
    const mw = aiRateLimit({ cap: 100, windowSec: 60, costFn: () => 10 });
    const workspaceId = `ws-headers-${Date.now()}`;
    const out = await invoke(mw, createReq({ workspaceId }));
    assert.equal(out.nextCalled, true);
    assert.equal(out.res.headers["ratelimit-limit"], "100");
    assert.equal(out.res.headers["ratelimit-remaining"], "90");
    assert.ok(Number(out.res.headers["ratelimit-reset"]) > 0);
  });

  await run("emits RateLimit-* headers + Retry-After on 429", async () => {
    const mw = aiRateLimit({ cap: 10, windowSec: 60, costFn: () => 10 });
    const workspaceId = `ws-headers-429-${Date.now()}`;
    await invoke(mw, createReq({ workspaceId }));
    const out = await invoke(mw, createReq({ workspaceId }));
    assert.equal(out.res.statusCode, 429);
    assert.equal(out.res.headers["ratelimit-limit"], "10");
    assert.equal(out.res.headers["ratelimit-remaining"], "0");
    assert.ok(Number(out.res.headers["retry-after"]) > 0);
  });

  await run("RateLimit-Limit header is consistent across mixed-cost requests within a window", async () => {
    // Regression: an earlier shape kept two caps (aiCap / regularCap) but
    // shared the same Redis key, so the header flickered between values
    // when AI mutations and regular calls landed in the same window — and
    // the 429 trigger depended on which call type happened to be tested.
    // Single-cap design pins this header to one value forever in a window.
    const mw = aiRateLimit({ cap: 50, windowSec: 60 });
    const workspaceId = `ws-mixed-${Date.now()}`;
    const aiReq = { ...createReq({ workspaceId }), method: "POST" };
    const getReq = { ...createReq({ workspaceId }), method: "GET" };
    const aiOut = await invoke(mw, aiReq);
    const getOut = await invoke(mw, getReq);
    assert.equal(aiOut.res.headers["ratelimit-limit"], "50");
    assert.equal(getOut.res.headers["ratelimit-limit"], "50");
  });

  if (failed) process.exit(1);
  console.log(`ai-rate-limit.test.js: ${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
