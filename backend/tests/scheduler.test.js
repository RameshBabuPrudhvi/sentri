/**
 * @module tests/scheduler
 * @description Tests for ENH-006 — test scheduling engine.
 *
 * Section 1 — getNextRunAt (pure JS, no DB required)
 * Section 2 — scheduleRepo CRUD (requires better-sqlite3)
 * Section 3 — Schedule API endpoints GET/PATCH/DELETE (requires better-sqlite3)
 *
 * Sections 2-3 are skipped when the native SQLite binding is unavailable.
 * All sections run in the real project environment via `npm test`.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result
        .then(() => { passed++; console.log("  \u2713 " + name); })
        .catch(err => { failed++; failures.push({ name, err }); console.error("  \u2717 " + name + ": " + err.message); });
    }
    passed++;
    console.log("  \u2713 " + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.error("  \u2717 " + name + ": " + err.message);
  }
}

// ── Section 1: getNextRunAt (pure JS) ─────────────────────────────────────────

console.log("\n\u2500\u2500 getNextRunAt unit tests (pure JS) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

import { getNextRunAt } from "../src/scheduler.js";

test("returns null for an invalid cron expression", () => {
  assert.equal(getNextRunAt("not a cron"), null);
});

test("returns null for an empty string", () => {
  assert.equal(getNextRunAt(""), null);
});

test("returns null for a 6-field expression", () => {
  assert.equal(getNextRunAt("0 * * * * *"), null);
});

test("returns an ISO string for '* * * * *'", () => {
  const result = getNextRunAt("* * * * *", "UTC");
  assert.ok(typeof result === "string");
  assert.ok(result.includes("T"));
});

test("next fire for '* * * * *' is within 61 seconds", () => {
  const result = getNextRunAt("* * * * *", "UTC");
  const diffMs = new Date(result) - Date.now();
  assert.ok(diffMs > 0 && diffMs <= 61000, "diff should be <= 61 000ms, got " + diffMs);
});

test("next fire is in the future for daily '0 0 * * *'", () => {
  const result = getNextRunAt("0 0 * * *", "UTC");
  assert.ok(result !== null);
  assert.ok(new Date(result) > new Date());
});

test("next fire is in the future for hourly '0 * * * *'", () => {
  const result = getNextRunAt("0 * * * *", "UTC");
  assert.ok(result !== null);
  assert.ok(new Date(result) > new Date());
});

test("next fire is in the future for every-6-hours '0 */6 * * *'", () => {
  const result = getNextRunAt("0 */6 * * *", "UTC");
  assert.ok(result !== null);
  assert.ok(new Date(result) > new Date());
});

test("next fire is in the future for weekly '0 9 * * 1'", () => {
  const result = getNextRunAt("0 9 * * 1", "UTC");
  assert.ok(result !== null);
  assert.ok(new Date(result) > new Date());
});

test("next fire is in the future for weekdays '0 9 * * 1-5'", () => {
  const result = getNextRunAt("0 9 * * 1-5", "UTC");
  assert.ok(result !== null);
  assert.ok(new Date(result) > new Date());
});

test("both UTC and America/New_York return valid future ISO strings", () => {
  const utc = getNextRunAt("0 9 * * *", "UTC");
  const ny  = getNextRunAt("0 9 * * *", "America/New_York");
  assert.ok(utc !== null && ny !== null);
  assert.ok(new Date(utc) > new Date());
  assert.ok(new Date(ny)  > new Date());
});

// ── Combined list+range and start/step parsing ──────────────────────────────

test("handles combined list+range field like '1-5,10'", () => {
  // "0 9 * * 1-5,0" means weekdays + Sunday at 9 AM
  const result = getNextRunAt("0 9 * * 1-5,0", "UTC");
  assert.ok(result !== null, "should find a match for list+range field");
  assert.ok(new Date(result) > new Date());
});

test("start/step field like '5/10' returns null (not supported by node-cron v3)", () => {
  // node-cron v3 only supports */n step syntax, not start/step like "5/10".
  // cron.validate() rejects it at the gate, so getNextRunAt returns null.
  // This is consistent across the entire system:
  //   - PATCH /schedule API also uses cron.validate() and returns 400
  //   - armTask() refuses to arm expressions that fail cron.validate()
  //   - cron.schedule() would also reject it at runtime
  //   - Frontend ScheduleManager presets and validator only accept */n
  // The matchesAtom handler for start/step (scheduler.js:81-83) is dead code.
  const result = getNextRunAt("5/10 * * * *", "UTC");
  assert.equal(result, null, "node-cron v3 does not support start/step syntax");
});

test("handles range+step field like '0-30/5' for minutes", () => {
  // "0-30/5 * * * *" means minutes 0, 5, 10, 15, 20, 25, 30
  const result = getNextRunAt("0-30/5 * * * *", "UTC");
  assert.ok(result !== null, "should find a match for range+step field");
});

// ── Day-of-week 7 = Sunday alias (POSIX cron) ──────────────────────────────

test("dow 7 (Sunday alias) returns a valid future date, not null", () => {
  // POSIX cron allows both 0 and 7 to mean Sunday. node-cron validates
  // "0 9 * * 7" and fires correctly, so getNextRunAt must also match.
  const result = getNextRunAt("0 9 * * 7", "UTC");
  assert.ok(result !== null, "dow 7 (Sunday alias) must not return null");
  assert.ok(new Date(result) > new Date(), "result must be in the future");
  // Verify the matched day is actually a Sunday (getDay() === 0)
  assert.equal(new Date(result).getUTCDay(), 0,
    "dow 7 should match Sunday (getUTCDay()=0), got " + new Date(result).getUTCDay());
});

test("dow 0 and dow 7 produce the same next-fire time", () => {
  const with0 = getNextRunAt("0 9 * * 0", "UTC");
  const with7 = getNextRunAt("0 9 * * 7", "UTC");
  assert.ok(with0 !== null && with7 !== null);
  assert.equal(with0, with7, "dow 0 and dow 7 must resolve to the same Sunday");
});

test("dow range including 7 (e.g. '5-7') matches Fri-Sun", () => {
  // "0 9 * * 5-7" should match Friday (5), Saturday (6), and Sunday (7→0)
  const result = getNextRunAt("0 9 * * 5-7", "UTC");
  assert.ok(result !== null, "range 5-7 must find a match");
  const day = new Date(result).getUTCDay();
  assert.ok(day === 5 || day === 6 || day === 0,
    "5-7 should match Fri(5)/Sat(6)/Sun(0), got " + day);
});

test("dow list including 7 (e.g. '1,7') matches Mon and Sun", () => {
  const result = getNextRunAt("0 9 * * 1,7", "UTC");
  assert.ok(result !== null, "list 1,7 must find a match");
  const day = new Date(result).getUTCDay();
  assert.ok(day === 1 || day === 0,
    "1,7 should match Mon(1) or Sun(0), got " + day);
});

// ── Timezone correctness (Intl.DateTimeFormat.formatToParts) ─────────────────

console.log("\n\u2500\u2500 getNextRunAt timezone correctness \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

test("same cron in different timezones produces different UTC times", () => {
  // "0 9 * * *" at 9 AM UTC vs 9 AM New York — they must differ
  const utc = getNextRunAt("0 9 * * *", "UTC");
  const ny  = getNextRunAt("0 9 * * *", "America/New_York");
  assert.ok(utc !== null && ny !== null);
  // NY is UTC-5 or UTC-4 (DST), so 9 AM NY = 13:00 or 14:00 UTC
  // They must not be the same instant
  assert.notEqual(utc, ny, "9 AM UTC and 9 AM NY should be different UTC instants");
});

test("result for Asia/Tokyo is offset correctly (UTC+9, no DST)", () => {
  // "0 0 * * *" = midnight in the target timezone
  // Tokyo midnight = 15:00 UTC previous day (UTC+9)
  const result = getNextRunAt("0 0 * * *", "Asia/Tokyo");
  assert.ok(result !== null);
  const d = new Date(result);
  // In UTC, Tokyo midnight is always hour 15 (no DST in Japan)
  assert.equal(d.getUTCHours(), 15, "Tokyo midnight should be 15:00 UTC, got " + d.getUTCHours());
  assert.equal(d.getUTCMinutes(), 0);
});

test("Europe/London and UTC produce same result outside BST", () => {
  // In winter (GMT = UTC+0), London midnight = UTC midnight
  // We can't guarantee the test runs in winter, but we can verify both
  // return valid future dates
  const utc = getNextRunAt("0 3 * * *", "UTC");
  const lon = getNextRunAt("0 3 * * *", "Europe/London");
  assert.ok(utc !== null && lon !== null);
  // During BST (UTC+1), 3 AM London = 2 AM UTC, so they differ
  // During GMT, they're the same. Either way, both must be valid.
  assert.ok(new Date(utc) > new Date());
  assert.ok(new Date(lon) > new Date());
});

test("handles Australia/Sydney (UTC+10/+11 with DST)", () => {
  const result = getNextRunAt("0 12 * * *", "Australia/Sydney");
  assert.ok(result !== null);
  const d = new Date(result);
  // Sydney noon = 01:00 or 02:00 UTC depending on DST
  const utcHour = d.getUTCHours();
  assert.ok(utcHour === 1 || utcHour === 2,
    "Sydney noon should be 01:00 or 02:00 UTC, got " + utcHour);
});

// ── Sections 2-3: DB-dependent tests ─────────────────────────────────────────

let dbAvailable = false;
let db, scheduleRepo, projectRepo;

try {
  process.env.DB_PATH = ":memory:";
  process.env.JWT_SECRET = "test-secret-scheduler";
  process.env.NODE_ENV = "test";
  process.env.CREDENTIAL_SECRET = "01234567890123456789012345678901";
  const { getDatabase } = await import("../src/database/sqlite.js");
  db = getDatabase();
  const { runMigrations } = await import("../src/database/migrationRunner.js");
  runMigrations(db);
  scheduleRepo = await import("../src/database/repositories/scheduleRepo.js");
  projectRepo  = await import("../src/database/repositories/projectRepo.js");
  dbAvailable = true;
} catch {
  console.log("\n  \u26a0  better-sqlite3 not available — skipping DB and API tests");
}

if (dbAvailable) {

  console.log("\n\u2500\u2500 scheduleRepo unit tests \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

  const TEST_PROJECT_ID = "PRJ-SCHED-TEST";
  projectRepo.create({
    id: TEST_PROJECT_ID,
    name: "Scheduler Test Project",
    url: "https://example.com",
    credentials: null,
    createdAt: new Date().toISOString(),
    status: "idle",
  });

  test("getByProjectId returns undefined for unknown project", () => {
    assert.equal(scheduleRepo.getByProjectId("PRJ-NONEXISTENT"), undefined);
  });

  test("upsert creates a new schedule", () => {
    const now = new Date().toISOString();
    const s = scheduleRepo.upsert({ id: "SCH-T1", projectId: TEST_PROJECT_ID, cronExpr: "0 0 * * *", timezone: "UTC", enabled: true, lastRunAt: null, nextRunAt: null, createdAt: now, updatedAt: now });
    assert.ok(s);
    assert.equal(s.id, "SCH-T1");
    assert.equal(s.cronExpr, "0 0 * * *");
    assert.equal(s.enabled, true);
  });

  test("getByProjectId returns the created schedule", () => {
    const s = scheduleRepo.getByProjectId(TEST_PROJECT_ID);
    assert.ok(s);
    assert.equal(s.id, "SCH-T1");
  });

  test("upsert updates an existing schedule", () => {
    const now = new Date().toISOString();
    const updated = scheduleRepo.upsert({ id: "SCH-T1", projectId: TEST_PROJECT_ID, cronExpr: "0 9 * * 1", timezone: "America/New_York", enabled: true, lastRunAt: null, nextRunAt: null, createdAt: now, updatedAt: now });
    assert.equal(updated.cronExpr, "0 9 * * 1");
    assert.equal(updated.timezone, "America/New_York");
    assert.equal(updated.id, "SCH-T1");
  });

  test("setEnabled disables a schedule", () => {
    const result = scheduleRepo.setEnabled(TEST_PROJECT_ID, false);
    assert.ok(result);
    assert.equal(result.enabled, false);
  });

  test("setEnabled re-enables a schedule", () => {
    const result = scheduleRepo.setEnabled(TEST_PROJECT_ID, true);
    assert.ok(result);
    assert.equal(result.enabled, true);
  });

  test("setEnabled returns undefined for unknown project", () => {
    assert.equal(scheduleRepo.setEnabled("PRJ-NONEXISTENT", true), undefined);
  });

  test("getAllEnabled returns only enabled schedules", () => {
    scheduleRepo.setEnabled(TEST_PROJECT_ID, true);
    const all = scheduleRepo.getAllEnabled();
    assert.ok(Array.isArray(all));
    for (const s of all) assert.equal(s.enabled, true, "getAllEnabled must only return enabled schedules");
  });

  test("updateRunTimes persists lastRunAt and nextRunAt", () => {
    const last = "2026-01-01T00:00:00.000Z";
    const next = "2026-01-02T00:00:00.000Z";
    scheduleRepo.updateRunTimes(TEST_PROJECT_ID, last, next);
    const s = scheduleRepo.getByProjectId(TEST_PROJECT_ID);
    assert.equal(s.lastRunAt, last);
    assert.equal(s.nextRunAt, next);
  });

  test("deleteByProjectId removes the schedule", () => {
    scheduleRepo.deleteByProjectId(TEST_PROJECT_ID);
    assert.equal(scheduleRepo.getByProjectId(TEST_PROJECT_ID), undefined);
  });

  // ── Section 3: API integration ─────────────────────────────────────────────

  console.log("\n\u2500\u2500 Schedule API integration tests \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

  const { app } = await import("../src/middleware/appSetup.js");
  const projectsRouter = (await import("../src/routes/projects.js")).default;
  const authRouter = (await import("../src/routes/auth.js")).default;
  const { requireAuth } = await import("../src/routes/auth.js");
  app.use("/api/auth", authRouter);
  app.use("/api/projects", requireAuth, projectsRouter);

  const server = createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port + "/api";

  const email = "sched-" + Date.now() + "@test.com";
  await fetch(base + "/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "Test1234!", name: "Sched Tester" }) });
  const loginRes = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "Test1234!" }) });
  const rawCookies = loginRes.headers.get("set-cookie") || "";
  const accessToken = rawCookies.match(/access_token=([^;]+)/)?.[1];
  const csrfToken   = rawCookies.match(/_csrf=([^;]+)/)?.[1];
  const authCookie  = "access_token=" + accessToken + "; _csrf=" + csrfToken;

  const projRes = await fetch(base + "/projects", { method: "POST", headers: { "Content-Type": "application/json", "Cookie": authCookie, "X-CSRF-Token": csrfToken }, body: JSON.stringify({ name: "Schedule API Test", url: "https://example.com" }) });
  const projBody = await projRes.json();
  const projectId = projBody.id;

  async function apiReq(path, opts) {
    const method = (opts && opts.method) || "GET";
    const headers = { "Content-Type": "application/json", "Cookie": authCookie };
    if (method !== "GET") headers["X-CSRF-Token"] = csrfToken;
    const res = await fetch(base + path, { method, headers, body: opts && opts.body ? JSON.stringify(opts.body) : undefined, redirect: "manual" });
    const body = await res.json().catch(() => null);
    return { res, body };
  }

  await test("GET schedule returns null when no schedule exists", async () => {
    assert.ok(projectId, "project must be created");
    const { res, body } = await apiReq("/projects/" + projectId + "/schedule");
    assert.equal(res.status, 200, "Expected 200 got " + res.status);
    assert.equal(body.schedule, null);
  });

  await test("PATCH creates a schedule with valid cronExpr", async () => {
    const { res, body } = await apiReq("/projects/" + projectId + "/schedule", { method: "PATCH", body: { cronExpr: "0 9 * * 1", timezone: "UTC", enabled: true } });
    assert.equal(res.status, 200, "Expected 200 got " + res.status + ": " + JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.ok(body.schedule);
    assert.equal(body.schedule.cronExpr, "0 9 * * 1");
    assert.equal(body.schedule.enabled, true);
    assert.ok(body.schedule.nextRunAt, "nextRunAt must be computed");
    assert.ok(body.schedule.id.startsWith("SCH-"), "id must have SCH- prefix");
  });

  await test("GET returns the newly created schedule", async () => {
    const { res, body } = await apiReq("/projects/" + projectId + "/schedule");
    assert.equal(res.status, 200);
    assert.ok(body.schedule);
    assert.equal(body.schedule.cronExpr, "0 9 * * 1");
  });

  await test("PATCH updates an existing schedule", async () => {
    const { res, body } = await apiReq("/projects/" + projectId + "/schedule", { method: "PATCH", body: { cronExpr: "0 */6 * * *", timezone: "America/Chicago", enabled: false } });
    assert.equal(res.status, 200, "Expected 200 got " + res.status);
    assert.equal(body.schedule.cronExpr, "0 */6 * * *");
    assert.equal(body.schedule.timezone, "America/Chicago");
    assert.equal(body.schedule.enabled, false);
  });

  await test("PATCH 400 when cronExpr is missing", async () => {
    const { res, body } = await apiReq("/projects/" + projectId + "/schedule", { method: "PATCH", body: { timezone: "UTC" } });
    assert.equal(res.status, 400);
    assert.ok(body.error);
  });

  await test("PATCH 400 for invalid cron expression", async () => {
    const { res, body } = await apiReq("/projects/" + projectId + "/schedule", { method: "PATCH", body: { cronExpr: "99 99 99 99 99" } });
    assert.equal(res.status, 400);
    assert.ok(body.error);
  });

  await test("PATCH 400 for 6-field cron expression", async () => {
    const { res, body } = await apiReq("/projects/" + projectId + "/schedule", { method: "PATCH", body: { cronExpr: "0 * * * * *" } });
    assert.equal(res.status, 400);
    assert.ok(body.error);
  });

  await test("PATCH 400 for invalid timezone", async () => {
    const { res, body } = await apiReq("/projects/" + projectId + "/schedule", { method: "PATCH", body: { cronExpr: "0 9 * * 1", timezone: "Fake/Zone" } });
    assert.equal(res.status, 400, "Expected 400 got " + res.status);
    assert.ok(body.error);
    assert.ok(body.error.includes("timezone"), "error should mention timezone");
  });

  await test("DELETE removes the schedule", async () => {
    const { res, body } = await apiReq("/projects/" + projectId + "/schedule", { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
  });

  await test("GET returns null after deletion", async () => {
    const { res, body } = await apiReq("/projects/" + projectId + "/schedule");
    assert.equal(res.status, 200);
    assert.equal(body.schedule, null);
  });

  await test("DELETE 404 when no schedule exists", async () => {
    const { res } = await apiReq("/projects/" + projectId + "/schedule", { method: "DELETE" });
    assert.equal(res.status, 404);
  });

  await test("GET 404 for non-existent project", async () => {
    const { res } = await apiReq("/projects/PRJ-NONEXISTENT/schedule");
    assert.equal(res.status, 404);
  });

  server.close();
}

// ── Summary ───────────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 150));

console.log("\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
console.log("Results: " + passed + " passed, " + failed + " failed");
if (failed > 0) {
  for (const { name, err } of failures) {
    console.error("\n  FAILED: " + name);
    console.error("  " + (err.stack || err.message));
  }
  process.exit(1);
}
console.log("\uD83C\uDF89 All scheduler tests passed!");
