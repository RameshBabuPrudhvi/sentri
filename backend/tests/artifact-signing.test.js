/**
 * @module tests/artifact-signing
 * @description Tests for HMAC-signed artifact URLs and the client-error endpoint.
 *
 * Covers:
 *   - signArtifactUrl() produces a URL with ?token= and ?exp= params
 *   - Valid signed URLs pass the /artifacts middleware (200 for existing files)
 *   - Requests without a token are rejected (401)
 *   - Requests with a tampered token are rejected (401)
 *   - Requests with an expired token are rejected (401)
 *   - POST /api/system/client-error accepts crash reports and returns 200
 *   - POST /api/system/client-error with empty body still returns 200
 */

import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { app, ARTIFACTS_DIR, signArtifactUrl } from "../src/middleware/appSetup.js";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import systemRouter from "../src/routes/system.js";
import { getDatabase } from "../src/database/sqlite.js";

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api", requireAuth, systemRouter);
  mounted = true;
}

function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM healing_history");
  db.exec("DELETE FROM activities");
  db.exec("DELETE FROM runs");
  db.exec("DELETE FROM tests");
  db.exec("DELETE FROM oauth_ids");
  db.exec("DELETE FROM projects");
  db.exec("DELETE FROM users");
  db.exec("UPDATE counters SET value = 0");
}

/** Extract a named cookie value from a fetch Response's Set-Cookie header. */
function extractCookie(res, name) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const c of raw) {
    const match = c.match(new RegExp(`^${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

/** Build a Cookie header string from parsed cookies. */
function buildCookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function main() {
  mountRoutesOnce();
  resetDb();

  // Create a dummy artifact file so express.static can serve it
  const screenshotsDir = path.join(ARTIFACTS_DIR, "screenshots");
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
  const testFile = "test-artifact.png";
  const testFilePath = path.join(screenshotsDir, testFile);
  fs.writeFileSync(testFilePath, Buffer.from("fake-png-data"));

  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // ── signArtifactUrl() unit tests ────────────────────────────────────────

    const artifactPath = `/artifacts/screenshots/${testFile}`;
    const signedUrl = signArtifactUrl(artifactPath);

    // Should contain token and exp query params
    assert.ok(signedUrl.includes("?token="), "Signed URL should contain ?token=");
    assert.ok(signedUrl.includes("&exp="), "Signed URL should contain &exp=");
    assert.ok(signedUrl.startsWith(artifactPath), "Signed URL should start with the original path");

    // Parse the signed URL to extract token and exp
    const url = new URL(signedUrl, base);
    const token = url.searchParams.get("token");
    const exp = url.searchParams.get("exp");
    assert.ok(token, "token param should be present");
    assert.ok(exp, "exp param should be present");
    const expMs = parseInt(exp, 10);
    assert.ok(expMs > Date.now(), "exp should be in the future");

    // ── Valid signed URL returns the artifact ────────────────────────────────

    let res = await fetch(`${base}${signedUrl}`);
    assert.equal(res.status, 200, "Valid signed URL should return 200");
    const body = await res.text();
    assert.equal(body, "fake-png-data", "Should serve the artifact file contents");

    // Check Cache-Control header
    const cacheControl = res.headers.get("cache-control");
    assert.ok(cacheControl && cacheControl.includes("no-store"), "Should set Cache-Control: no-store");

    // ── Missing token returns 401 ────────────────────────────────────────────

    res = await fetch(`${base}${artifactPath}`);
    assert.equal(res.status, 401, "Request without token should return 401");
    const noTokenBody = await res.json();
    assert.ok(noTokenBody.error, "401 response should include error message");

    // ── Tampered token returns 401 ───────────────────────────────────────────

    res = await fetch(`${base}${artifactPath}?token=tampered-value&exp=${exp}`);
    assert.equal(res.status, 401, "Tampered token should return 401");

    // ── Expired token returns 401 ────────────────────────────────────────────

    const pastExp = Date.now() - 60000; // 1 minute ago
    res = await fetch(`${base}${artifactPath}?token=${token}&exp=${pastExp}`);
    assert.equal(res.status, 401, "Expired token should return 401");

    // ── POST /api/system/client-error ────────────────────────────────────────
    // This endpoint requires auth, so register + login first

    const email = `artifact-${Date.now()}@test.local`;
    res = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Artifact User", email, password: "Password123!" }),
    });
    assert.equal(res.status, 201);

    res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "Password123!" }),
    });
    assert.equal(res.status, 200);
    const accessToken = extractCookie(res, "access_token");
    const csrf = extractCookie(res, "_csrf");
    assert.ok(accessToken, "Should get access_token cookie");
    assert.ok(csrf, "Should get _csrf cookie");

    const cookies = buildCookieHeader({ access_token: accessToken, _csrf: csrf });

    // POST with a valid crash report
    res = await fetch(`${base}/api/system/client-error`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookies,
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({
        message: "Test error from unit test",
        stack: "Error: Test error\n    at Object.<anonymous> (test.js:1:1)",
        componentStack: "\n    at ErrorBoundary\n    at App",
        url: "http://localhost:3000/dashboard",
      }),
    });
    assert.equal(res.status, 200, "Client error endpoint should return 200");
    const clientErrorBody = await res.json();
    assert.equal(clientErrorBody.ok, true, "Response should be { ok: true }");

    // POST with empty body should still return 200 (never throw)
    res = await fetch(`${base}/api/system/client-error`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookies,
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200, "Client error endpoint with empty body should return 200");

    // Unauthenticated request should be rejected
    res = await fetch(`${base}/api/system/client-error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "should fail" }),
    });
    assert.equal(res.status, 401, "Unauthenticated client-error POST should return 401");

    console.log("✅ artifact-signing: all checks passed");
  } finally {
    // Clean up test artifact
    try { fs.unlinkSync(testFilePath); } catch { /* ignore */ }
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ artifact-signing failed:", err);
  process.exit(1);
});
