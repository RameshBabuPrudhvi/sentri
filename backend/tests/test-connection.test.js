/**
 * @module tests/test-connection
 * @description Integration tests for `POST /api/v1/test-connection` — the URL
 * reachability probe fired by the "Test" button in `NewProject.jsx`.
 *
 * Covers:
 *   - Input validation (missing / malformed / non-http protocol).
 *   - SSRF rejection of localhost, loopback, private IPs, and cloud metadata.
 *   - Auth / role gating (qa_lead required).
 *   - The new `ALLOW_PRIVATE_URLS=true` dev escape hatch — confirms the SSRF
 *     guard is bypassed so developers can probe `http://localhost:<port>`
 *     during local dev.
 *
 * Live-fetch assertions avoid relying on real external DNS by targeting the
 * test server itself (127.0.0.1) when the escape hatch is enabled.
 */

import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import systemRouter from "../src/routes/system.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, req, workspaceScope } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api", requireAuth, workspaceScope, systemRouter);
  mounted = true;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();
  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });
  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const { test, summary } = t.createTestRunner();

  try {
    const { token } = await t.registerAndLogin(base, {
      name: "Test Conn User",
      email: `testconn-${Date.now()}@test.local`,
      password: "Password123!",
    });
    const authCookie = `access_token=${token}`;

    console.log("\n── Input validation ──────────────────────────────────────────");

    await test("401 without auth", async () => {
      const r = await fetch(`${base}/api/test-connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      assert.equal(r.status, 401);
    });

    await test("400 when url is missing", async () => {
      const out = await req(base, "/api/test-connection", {
        method: "POST", cookie: authCookie, body: {},
      });
      assert.equal(out.res.status, 400);
      assert.match(out.json.error, /url is required/i);
    });

    await test("400 for malformed URL", async () => {
      const out = await req(base, "/api/test-connection", {
        method: "POST", cookie: authCookie, body: { url: "not a url" },
      });
      assert.equal(out.res.status, 400);
      assert.match(out.json.error, /Invalid URL format/i);
    });

    await test("400 for non-http protocol (ftp://)", async () => {
      const out = await req(base, "/api/test-connection", {
        method: "POST", cookie: authCookie, body: { url: "ftp://example.com" },
      });
      assert.equal(out.res.status, 400);
      assert.match(out.json.error, /http or https/i);
    });

    console.log("\n── SSRF defaults (ALLOW_PRIVATE_URLS unset) ──────────────────");
    // Sanity: the dev escape hatch must default to off so prod stays safe.
    delete process.env.ALLOW_PRIVATE_URLS;

    const SSRF_CASES = [
      { url: "http://localhost:3000",               label: "localhost hostname" },
      { url: "http://127.0.0.1:3000",               label: "loopback IPv4" },
      { url: "http://10.0.0.1",                     label: "10.0.0.0/8 private" },
      { url: "http://192.168.1.1",                  label: "192.168.0.0/16 private" },
      { url: "http://172.16.0.1",                   label: "172.16.0.0/12 private" },
      { url: "http://169.254.169.254",              label: "AWS/GCP cloud metadata" },
      { url: "http://metadata.google.internal",     label: "GCP metadata hostname" },
      { url: "http://[::1]:3000",                   label: "IPv6 loopback" },
    ];
    for (const { url, label } of SSRF_CASES) {
      await test(`rejects ${label} (${url})`, async () => {
        const out = await req(base, "/api/test-connection", {
          method: "POST", cookie: authCookie, body: { url },
        });
        assert.equal(out.res.status, 400, `expected 400, got ${out.res.status}: ${JSON.stringify(out.json)}`);
        assert.match(out.json.error, /localhost|private|internal/i);
      });
    }

    console.log("\n── ALLOW_PRIVATE_URLS dev escape hatch ───────────────────────");

    // Selective fetch stub — only intercepts outbound HEAD probes to the
    // target URL the test-connection route issues. Inbound HTTP from `req()`
    // to the test server still uses the real fetch so auth cookies, CSRF,
    // and JSON parsing keep working. Avoids the flakiness of hitting
    // `${base}/health` for real, which is at the mercy of the server's
    // `AbortSignal.timeout(10000)` and the CI event loop.
    const realFetch = global.fetch;
    const PROBE_TARGET = "http://localhost:9999/probe";
    function installProbeStub(status) {
      global.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url === PROBE_TARGET && init?.method === "HEAD") {
          return new Response(null, { status });
        }
        return realFetch(input, init);
      };
    }
    function restoreFetch() { global.fetch = realFetch; }

    await test("ALLOW_PRIVATE_URLS=true permits loopback — HEAD succeeds via stubbed fetch", async () => {
      // With the escape hatch enabled, the SSRF guard is skipped and the
      // route performs a real HEAD request. We stub fetch so the probe
      // resolves deterministically with HTTP 204, avoiding the
      // AbortSignal.timeout(10000) race under CI load.
      process.env.ALLOW_PRIVATE_URLS = "true";
      installProbeStub(204);
      try {
        const out = await req(base, "/api/test-connection", {
          method: "POST", cookie: authCookie, body: { url: PROBE_TARGET },
        });
        assert.equal(out.res.status, 200, `expected 200, got ${out.res.status}: ${JSON.stringify(out.json)}`);
        assert.equal(out.json.ok, true);
        assert.equal(out.json.status, 204);
      } finally {
        restoreFetch();
        delete process.env.ALLOW_PRIVATE_URLS;
      }
    });

    await test("ALLOW_PRIVATE_URLS=true surfaces non-2xx status from the target", async () => {
      // The route does not treat 4xx/5xx as a failure — it returns whatever
      // the upstream responded with so users can distinguish "unreachable"
      // from "reachable but erroring". Confirm a 500 still produces ok:true.
      process.env.ALLOW_PRIVATE_URLS = "true";
      installProbeStub(500);
      try {
        const out = await req(base, "/api/test-connection", {
          method: "POST", cookie: authCookie, body: { url: PROBE_TARGET },
        });
        assert.equal(out.res.status, 200);
        assert.equal(out.json.ok, true);
        assert.equal(out.json.status, 500);
      } finally {
        restoreFetch();
        delete process.env.ALLOW_PRIVATE_URLS;
      }
    });

    await test("ALLOW_PRIVATE_URLS=true returns 502 when the target is unreachable", async () => {
      // Stub fetch to throw — simulates DNS failure or connection refused.
      // The route catches and returns a structured 502.
      process.env.ALLOW_PRIVATE_URLS = "true";
      global.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url === PROBE_TARGET && init?.method === "HEAD") {
          throw new Error("ECONNREFUSED");
        }
        return realFetch(input, init);
      };
      try {
        const out = await req(base, "/api/test-connection", {
          method: "POST", cookie: authCookie, body: { url: PROBE_TARGET },
        });
        assert.equal(out.res.status, 502);
        assert.equal(out.json.ok, false);
        assert.match(out.json.error, /ECONNREFUSED/);
      } finally {
        restoreFetch();
        delete process.env.ALLOW_PRIVATE_URLS;
      }
    });

    await test("ALLOW_PRIVATE_URLS=true still rejects non-http protocols (pre-SSRF guard)", async () => {
      // Protocol check runs BEFORE the escape hatch; `ftp://` must still 400.
      process.env.ALLOW_PRIVATE_URLS = "true";
      try {
        const out = await req(base, "/api/test-connection", {
          method: "POST", cookie: authCookie, body: { url: "ftp://localhost" },
        });
        assert.equal(out.res.status, 400);
        assert.match(out.json.error, /http or https/i);
      } finally {
        delete process.env.ALLOW_PRIVATE_URLS;
      }
    });

    await test("ALLOW_PRIVATE_URLS=true still rejects malformed URLs (pre-SSRF guard)", async () => {
      process.env.ALLOW_PRIVATE_URLS = "true";
      try {
        const out = await req(base, "/api/test-connection", {
          method: "POST", cookie: authCookie, body: { url: "not a url" },
        });
        assert.equal(out.res.status, 400);
        assert.match(out.json.error, /Invalid URL format/i);
      } finally {
        delete process.env.ALLOW_PRIVATE_URLS;
      }
    });

    await test("ALLOW_PRIVATE_URLS only activates on literal string \"true\" (not truthy)", async () => {
      // Defence-in-depth: accidental `ALLOW_PRIVATE_URLS=1` or `=yes` must
      // NOT bypass the SSRF guard — only the explicit literal "true" works.
      for (const val of ["1", "yes", "on", "TRUE", " true", "true "]) {
        process.env.ALLOW_PRIVATE_URLS = val;
        try {
          const out = await req(base, "/api/test-connection", {
            method: "POST", cookie: authCookie, body: { url: "http://localhost:3000" },
          });
          assert.equal(out.res.status, 400, `value ${JSON.stringify(val)} must NOT bypass SSRF (got ${out.res.status})`);
        } finally {
          delete process.env.ALLOW_PRIVATE_URLS;
        }
      }
    });
  } finally {
    summary("test-connection");
    env.restore();
    await new Promise((r) => server.close(r));
  }
}

main().catch((err) => {
  console.error("❌ test-connection test run failed:", err);
  process.exit(1);
});
