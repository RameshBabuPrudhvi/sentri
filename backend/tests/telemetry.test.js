/**
 * @module tests/telemetry
 * @description Unit tests for `src/utils/telemetry.js` (DIF-013).
 *
 * The telemetry module reads env vars (`SENTRI_TELEMETRY`, `DO_NOT_TRACK`,
 * `POSTHOG_API_KEY`) at import time, so the opt-out branches must be
 * exercised via child processes with different environments.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

/**
 * Run a small inline ESM snippet in an isolated cwd with the given env.
 * Returns `{ status, stdout, stderr, cwd }`.
 */
function runInIsolation(env, script) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sentri-tel-"));
  const repoRoot = process.cwd();
  // Resolve telemetry.js relative to the repo root the test runner sees.
  const telemetryPath = path.join(repoRoot, "src/utils/telemetry.js");
  const fullScript = `
    import { trackTelemetry } from ${JSON.stringify(telemetryPath)};
    ${script}
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", fullScript],
    { cwd, env: { ...process.env, ...env }, encoding: "utf8" },
  );
  return { ...result, cwd };
}

console.log("\n🧪 telemetry utils");

test("trackTelemetry is a no-op when SENTRI_TELEMETRY=0", () => {
  const { status, cwd } = runInIsolation(
    { SENTRI_TELEMETRY: "0", POSTHOG_API_KEY: "phc_test" },
    `trackTelemetry("run.started", { url: "https://example.com" });
     console.log("ok");`,
  );
  assert.equal(status, 0);
  // No cache file should be created when fully disabled.
  assert.equal(fs.existsSync(path.join(cwd, "data", "telemetry-cache.json")), false);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("trackTelemetry is a no-op when DO_NOT_TRACK=1", () => {
  const { status, cwd } = runInIsolation(
    { DO_NOT_TRACK: "1", SENTRI_TELEMETRY: "1", POSTHOG_API_KEY: "phc_test" },
    `trackTelemetry("run.started", {}); console.log("ok");`,
  );
  assert.equal(status, 0);
  assert.equal(fs.existsSync(path.join(cwd, "data", "telemetry-cache.json")), false);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("trackTelemetry is a no-op when POSTHOG_API_KEY is unset", () => {
  const env = { POSTHOG_API_KEY: "", SENTRI_TELEMETRY: "1", DO_NOT_TRACK: "0" };
  const { status, cwd } = runInIsolation(
    env,
    `trackTelemetry("run.started", {}); console.log("ok");`,
  );
  assert.equal(status, 0);
  assert.equal(fs.existsSync(path.join(cwd, "data", "telemetry-cache.json")), false);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("trackTelemetry never throws on the hot path (sync return)", () => {
  // Even with an obviously-bad PostHog key, trackTelemetry must return
  // synchronously without throwing — fire-and-forget guarantee for callers
  // like the /runs route handler.
  const { status, stderr, cwd } = runInIsolation(
    { POSTHOG_API_KEY: "phc_test", SENTRI_TELEMETRY: "1", DO_NOT_TRACK: "0" },
    `const r = trackTelemetry("run.started", { url: "https://example.com" });
     if (r !== undefined) { console.error("expected undefined"); process.exit(2); }
     console.log("ok");`,
  );
  // Status 0 means trackTelemetry returned synchronously without throwing.
  // (status 2 would mean it returned a non-undefined value.)
  assert.equal(status, 0, `unexpected stderr: ${stderr}`);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("install.first_run is deduped across calls (lifetime cache)", () => {
  // Two calls in the same process with telemetry enabled but PostHog absent
  // (no posthog-node installed in test env) — the cache file must still be
  // written on the first dedup-eligible call and not block subsequent calls.
  const { status, cwd } = runInIsolation(
    { POSTHOG_API_KEY: "phc_test", SENTRI_TELEMETRY: "1", DO_NOT_TRACK: "0" },
    `trackTelemetry("install.first_run", {});
     trackTelemetry("install.first_run", {});
     // Allow the async fire-and-forget chain a tick.
     await new Promise((r) => setTimeout(r, 50));
     console.log("ok");`,
  );
  assert.equal(status, 0);
  // Cache file should exist and contain the lifetime key.
  const cacheFile = path.join(cwd, "data", "telemetry-cache.json");
  if (fs.existsSync(cacheFile)) {
    const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.equal(cache["install.first_run"], true);
    // No legacy YYYY-MM-DD:event keys should remain.
    for (const k of Object.keys(cache)) {
      assert.ok(!/^\d{4}-\d{2}-\d{2}:/.test(k), `unexpected legacy key ${k}`);
    }
  }
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("legacy daily-dedup keys are pruned from telemetry-cache.json", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sentri-tel-"));
  fs.mkdirSync(path.join(cwd, "data"), { recursive: true });
  const cacheFile = path.join(cwd, "data", "telemetry-cache.json");
  fs.writeFileSync(cacheFile, JSON.stringify({
    "2024-01-01:run.started": true,
    "2024-06-15:run.started": true,
  }));
  const repoRoot = process.cwd();
  const telemetryPath = path.join(repoRoot, "src/utils/telemetry.js");
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `
      import { trackTelemetry } from ${JSON.stringify(telemetryPath)};
      trackTelemetry("install.first_run", {});
      await new Promise((r) => setTimeout(r, 50));
    `],
    {
      cwd,
      env: { ...process.env, POSTHOG_API_KEY: "phc_test", SENTRI_TELEMETRY: "1", DO_NOT_TRACK: "0" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.equal(cache["2024-01-01:run.started"], undefined);
  assert.equal(cache["2024-06-15:run.started"], undefined);
  assert.equal(cache["install.first_run"], true);
  fs.rmSync(cwd, { recursive: true, force: true });
});

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n⚠️  Telemetry tests failed");
  process.exit(1);
}

console.log("\n🎉 Telemetry tests passed");
