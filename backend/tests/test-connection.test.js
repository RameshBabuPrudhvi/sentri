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

    // ── Shared helpers ───────────────────────────────────────────────────────
    // Every test below posts `{ url }` to `/api/test-connection` with the same
    // auth cookie and parses the JSON response. `probe(body)` captures that
    // shape in one place so future test additions are a single-line call.
    const probe = (body) => req(base, "/api/test-connection", {
      method: "POST", cookie: authCookie, body,
    });

    // Every escape-hatch test sets `ALLOW_PRIVATE_URLS=true`, optionally installs
    // a fetch stub, runs the assertion, then restores both. `withEscapeHatch()`
    // encapsulates the setup/teardown so a new test only specifies the probe
    // behaviour (a stub function) and the assertion body.
    const realFetch = global.fetch;
    const PROBE_TARGET = "http://localhost:9999/probe";
    /**
     * Install a selective fetch stub that only intercepts the outbound HEAD
     * probe the route fires at `PROBE_TARGET`. All other traffic (the test
     * client's inbound calls to the Express server) still uses the real fetch
     * so auth cookies, CSRF, and JSON parsing keep working.
     *
     * @param {(init: object) => Response|Promise<Response>|never} stub
     *   Returns the response to serve for the probe. Throw to simulate a
     *   network failure (ECONNREFUSED, DNS, TLS).
     */
    function installProbeStub(stub) {
      global.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url === PROBE_TARGET && init?.method === "HEAD") return stub(init);
        return realFetch(input, init);
      };
    }
    /**
     * Run `fn` with `ALLOW_PRIVATE_URLS=true` and optionally a probe fetch
     * stub. Always restores `global.fetch` and deletes the env var in finally,
     * so tests can't leak state even if assertions throw.
     *
     * @param {{ stub?: Function }} opts
     * @param {Function} fn
     */
    async function withEscapeHatch({ stub } = {}, fn) {
      process.env.ALLOW_PRIVATE_URLS = "true";
      if (stub) installProbeStub(stub);
      try { await fn(); } finally {
        global.fetch = realFetch;
        delete process.env.ALLOW_PRIVATE_URLS;
      }
    }

    console.log("\n── Input validation ──────────────────────────────────────────");

    await test("401 without auth", async () => {
      const r = await fetch(`${base}/api/test-connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      assert.equal(r.status, 401);
    });

    // Table-driven input validation — one row per rejection vector so adding
    // a new case is a single-line addition without copy-pasting boilerplate.
    const INPUT_VALIDATION_CASES = [
      { label: "400 when url is missing",          body: {},                              errorMatch: /url is required/i     },
      { label: "400 for malformed URL",            body: { url: "not a url" },            errorMatch: /Invalid URL format/i  },
      { label: "400 for non-http protocol (ftp)",  body: { url: "ftp://example.com" },    errorMatch: /http or https/i       },
      { label: "400 for non-http protocol (file)", body: { url: "file:///etc/passwd" },   errorMatch: /http or https/i       },
      { label: "400 for javascript: URI",          body: { url: "javascript:alert(1)" },  errorMatch: /http or https/i       },
    ];
    for (const { label, body, errorMatch } of INPUT_VALIDATION_CASES) {
      await test(label, async () => {
        const out = await probe(body);
        assert.equal(out.res.status, 400, `expected 400, got ${out.res.status}: ${JSON.stringify(out.json)}`);
        assert.match(out.json.error, errorMatch);
      });
    }

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
        const out = await probe({ url });
        assert.equal(out.res.status, 400, `expected 400, got ${out.res.status}: ${JSON.stringify(out.json)}`);
        assert.match(out.json.error, /localhost|private|internal/i);
      });
    }

    console.log("\n── ALLOW_PRIVATE_URLS dev escape hatch ───────────────────────");

    // Table-driven escape-hatch probe outcomes. Each row specifies how the
    // stubbed HEAD probe should behave and what the route's response must
    // look like. Adding a new stubbed scenario (new status code, new error
    // class) is a single-line row — no setup/teardown boilerplate.
    const ESCAPE_HATCH_PROBE_CASES = [
      {
        label: "permits loopback — HEAD 204 → { ok:true, status:204 }",
        stub: () => new Response(null, { status: 204 }),
        assert: (out) => {
          assert.equal(out.res.status, 200, `expected 200, got ${out.res.status}: ${JSON.stringify(out.json)}`);
          assert.equal(out.json.ok, true);
          assert.equal(out.json.status, 204);
        },
      },
      {
        // The route doesn't treat upstream 4xx/5xx as a failure — it surfaces
        // whatever the target responded with so users can distinguish
        // "unreachable" from "reachable but erroring".
        label: "surfaces non-2xx status from the target (HEAD 500 → { ok:true, status:500 })",
        stub: () => new Response(null, { status: 500 }),
        assert: (out) => {
          assert.equal(out.res.status, 200);
          assert.equal(out.json.ok, true);
          assert.equal(out.json.status, 500);
        },
      },
      {
        // Simulates DNS failure / connection refused / TLS handshake error.
        label: "returns 502 when the target is unreachable (fetch throws)",
        stub: () => { throw new Error("ECONNREFUSED"); },
        assert: (out) => {
          assert.equal(out.res.status, 502);
          assert.equal(out.json.ok, false);
          assert.match(out.json.error, /ECONNREFUSED/);
        },
      },
    ];
    for (const { label, stub, assert: check } of ESCAPE_HATCH_PROBE_CASES) {
      await test(`ALLOW_PRIVATE_URLS=true — ${label}`, async () => {
        await withEscapeHatch({ stub }, async () => {
          const out = await probe({ url: PROBE_TARGET });
          check(out);
        });
      });
    }

    // Table-driven pre-SSRF-guard checks — protocol/format validation must
    // run BEFORE the escape hatch, so malformed URLs are still rejected even
    // when `ALLOW_PRIVATE_URLS=true`. If a future route change moves one of
    // these checks AFTER the hatch, these tests catch it.
    const PRE_GUARD_REJECTION_CASES = [
      { label: "non-http protocol (ftp://localhost)", body: { url: "ftp://localhost" }, errorMatch: /http or https/i      },
      { label: "malformed URL",                       body: { url: "not a url" },       errorMatch: /Invalid URL format/i },
    ];
    for (const { label, body, errorMatch } of PRE_GUARD_REJECTION_CASES) {
      await test(`ALLOW_PRIVATE_URLS=true still rejects ${label}`, async () => {
        await withEscapeHatch({}, async () => {
          const out = await probe(body);
          assert.equal(out.res.status, 400);
          assert.match(out.json.error, errorMatch);
        });
      });
    }

    // Defence-in-depth: accidental `ALLOW_PRIVATE_URLS=1` or `=yes` must NOT
    // bypass the SSRF guard — only the explicit literal "true" works.
    // Parameterised so new misspellings of "true" are a single-line add.
    const NON_ACTIVATING_VALUES = ["1", "yes", "on", "TRUE", " true", "true "];
    for (const val of NON_ACTIVATING_VALUES) {
      await test(`ALLOW_PRIVATE_URLS=${JSON.stringify(val)} must NOT bypass SSRF`, async () => {
        process.env.ALLOW_PRIVATE_URLS = val;
        try {
          const out = await probe({ url: "http://localhost:3000" });
          assert.equal(out.res.status, 400, `value ${JSON.stringify(val)} must NOT bypass SSRF (got ${out.res.status})`);
        } finally {
          delete process.env.ALLOW_PRIVATE_URLS;
        }
      });
    }
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
