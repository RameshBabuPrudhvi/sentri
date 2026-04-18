/**
 * @module tests/notifications-api
 * @description Integration tests for FEA-001 — notification settings endpoints
 * and SSRF protection on webhook URLs.
 *
 * Exercises the full HTTP flow for:
 *   - GET    /api/projects/:id/notifications   (read settings)
 *   - PATCH  /api/projects/:id/notifications   (create/update settings)
 *   - DELETE /api/projects/:id/notifications   (remove settings)
 *
 * SSRF coverage:
 *   - PATCH rejects private IPs, localhost, .internal/.local hostnames
 *   - PATCH rejects non-http protocols (ftp://, file://)
 *   - PATCH accepts valid public URLs
 *
 * Maintainability: SSRF rejection cases are table-driven — add a row to
 * `SSRF_REJECT_CASES` to cover a new vector without writing a new test.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { req: apiReq } = t;
const { test, summary } = t.createTestRunner();

// ─── Mount routes once ────────────────────────────────────────────────────────

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  t.app.use("/api/auth", authRouter);
  t.app.use("/api/projects", requireAuth, t.workspaceScope, projectsRouter);
  mounted = true;
}

// ─── SSRF rejection cases (table-driven) ──────────────────────────────────────
// Each entry: [label, urlValue, fieldName]
// fieldName is the body key ("teamsWebhookUrl" or "webhookUrl") to test.
// Add a row here to cover a new SSRF vector — no new test function needed.

const SSRF_REJECT_CASES = [
  ["localhost",                "http://localhost:3000/hook",                    "teamsWebhookUrl"],
  ["127.0.0.1 (loopback)",    "http://127.0.0.1:8080/hook",                   "teamsWebhookUrl"],
  ["10.x private IP",         "http://10.0.0.5/hook",                         "webhookUrl"],
  ["172.16.x private IP",     "http://172.16.0.1/hook",                       "webhookUrl"],
  ["192.168.x private IP",    "http://192.168.1.1/hook",                      "teamsWebhookUrl"],
  ["169.254.x (cloud meta)",  "http://169.254.169.254/latest/meta-data/",     "webhookUrl"],
  [".internal hostname",      "https://myservice.internal/hook",              "teamsWebhookUrl"],
  [".local hostname",         "https://myhost.local/hook",                    "webhookUrl"],
  ["ftp:// protocol",         "ftp://example.com/hook",                       "teamsWebhookUrl"],
  ["file:// protocol",        "file:///etc/passwd",                           "webhookUrl"],
  ["0.0.0.0",                 "http://0.0.0.0/hook",                         "teamsWebhookUrl"],
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  mountRoutesOnce();
  const server = createServer(t.app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;

  try {
    // ── Setup: register, verify, login, create project ────────────────────
    const email = `notif-${Date.now()}@test.local`;

    const { token } = await t.registerAndLogin(base, {
      name: "Notif Tester", email, password: "Password123!",
    });
    const authCookie = "access_token=" + token;

    let out = await apiReq(base, "/api/projects", {
      method: "POST", cookie: authCookie,
      body: { name: "Notif Project", url: "https://example.com" },
    });
    const projectId = out.json.id;

    // ── GET /notifications — empty state ──────────────────────────────────

    console.log("\n\u2500\u2500 GET /notifications \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

    await test("GET returns null when no settings exist", async () => {
      out = await apiReq(base, `/api/projects/${projectId}/notifications`, { cookie: authCookie });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.notifications, null);
    });

    await test("GET 404 for non-existent project", async () => {
      out = await apiReq(base, "/api/projects/PRJ-FAKE/notifications", { cookie: authCookie });
      assert.equal(out.res.status, 404);
    });

    // ── PATCH /notifications — validation ─────────────────────────────────

    console.log("\n\u2500\u2500 PATCH /notifications \u2014 validation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

    await test("PATCH 400 when no channels configured", async () => {
      out = await apiReq(base, `/api/projects/${projectId}/notifications`, {
        method: "PATCH", cookie: authCookie, body: { enabled: true },
      });
      assert.equal(out.res.status, 400);
      assert.ok(out.json.error);
    });

    await test("PATCH 400 for invalid email address", async () => {
      out = await apiReq(base, `/api/projects/${projectId}/notifications`, {
        method: "PATCH", cookie: authCookie,
        body: { emailRecipients: "not-an-email" },
      });
      assert.equal(out.res.status, 400);
      assert.ok(out.json.error.includes("Invalid email"));
    });

    // ── PATCH /notifications — SSRF rejection (table-driven) ──────────────

    console.log("\n\u2500\u2500 PATCH /notifications \u2014 SSRF rejection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

    for (const [label, url, field] of SSRF_REJECT_CASES) {
      await test(`PATCH 400 rejects ${label} in ${field}`, async () => {
        out = await apiReq(base, `/api/projects/${projectId}/notifications`, {
          method: "PATCH", cookie: authCookie,
          body: { [field]: url },
        });
        assert.equal(out.res.status, 400,
          `Expected 400 for ${label}, got ${out.res.status}: ${JSON.stringify(out.json)}`);
        assert.ok(out.json.error, "response should contain error message");
      });
    }

    // ── PATCH /notifications — success ────────────────────────────────────

    console.log("\n\u2500\u2500 PATCH /notifications \u2014 success \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

    await test("PATCH creates settings with valid public webhook URL", async () => {
      out = await apiReq(base, `/api/projects/${projectId}/notifications`, {
        method: "PATCH", cookie: authCookie,
        body: { webhookUrl: "https://93.184.216.34/hook", enabled: true },
      });
      assert.equal(out.res.status, 200, `Expected 200, got ${out.res.status}: ${JSON.stringify(out.json)}`);
      assert.equal(out.json.ok, true);
      assert.ok(out.json.notifications);
      assert.ok(out.json.notifications.id.startsWith("NS-"));
      assert.equal(out.json.notifications.enabled, true);
    });

    await test("PATCH creates settings with valid email recipients", async () => {
      out = await apiReq(base, `/api/projects/${projectId}/notifications`, {
        method: "PATCH", cookie: authCookie,
        body: { emailRecipients: "alice@example.com, bob@example.com" },
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.ok, true);
      assert.ok(out.json.notifications.emailRecipients.includes("alice@example.com"));
    });

    await test("PATCH updates existing settings (upsert)", async () => {
      out = await apiReq(base, `/api/projects/${projectId}/notifications`, {
        method: "PATCH", cookie: authCookie,
        body: { emailRecipients: "charlie@example.com", enabled: false },
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.notifications.emailRecipients, "charlie@example.com");
      assert.equal(out.json.notifications.enabled, false);
    });

    // ── GET /notifications — after create ─────────────────────────────────

    console.log("\n\u2500\u2500 GET /notifications \u2014 after create \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

    await test("GET returns the created settings", async () => {
      out = await apiReq(base, `/api/projects/${projectId}/notifications`, { cookie: authCookie });
      assert.equal(out.res.status, 200);
      assert.ok(out.json.notifications);
      assert.equal(out.json.notifications.emailRecipients, "charlie@example.com");
    });

    // ── DELETE /notifications ──────────────────────────────────────────────

    console.log("\n\u2500\u2500 DELETE /notifications \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

    await test("DELETE removes notification settings", async () => {
      out = await apiReq(base, `/api/projects/${projectId}/notifications`, {
        method: "DELETE", cookie: authCookie,
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.ok, true);
    });

    await test("GET returns null after deletion", async () => {
      out = await apiReq(base, `/api/projects/${projectId}/notifications`, { cookie: authCookie });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.notifications, null);
    });

    await test("DELETE 404 when no settings exist", async () => {
      out = await apiReq(base, `/api/projects/${projectId}/notifications`, {
        method: "DELETE", cookie: authCookie,
      });
      assert.equal(out.res.status, 404);
    });

    // ── Results ───────────────────────────────────────────────────────────

    summary("notifications-api integration");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("\u2717 notifications-api failed:", err);
  process.exit(1);
});
