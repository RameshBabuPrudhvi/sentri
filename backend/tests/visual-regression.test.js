/**
 * @module tests/visual-regression
 * @description Unit tests for baselineRepo + visualDiff (DIF-001).
 *
 * Uses an in-memory SQLite database (via DB_PATH=":memory:") so these
 * tests do not collide with the repo's on-disk dev database.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Route DB + artifact storage to a clean temp area BEFORE any imports
//    that might touch `getDatabase()` or resolve `ARTIFACTS_DIR`.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sentri-visual-"));
// Point the SQLite adapter at an empty file inside TMP_DIR so this test does
// not interfere with the repo's on-disk dev database. `path.resolve(":memory:")`
// would turn ":memory:" into a literal file path, not an in-memory DB — hence
// the explicit temp file.
process.env.DB_PATH = path.join(TMP_DIR, "test.db");

import { PNG } from "pngjs";
import { getDatabase } from "../src/database/sqlite.js";
import * as baselineRepo from "../src/database/repositories/baselineRepo.js";
import { diffScreenshot, acceptBaseline } from "../src/runner/visualDiff.js";
import { BASELINES_DIR, DIFFS_DIR } from "../src/runner/config.js";

// ── Mini test runner ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a solid-colour PNG buffer of the given size.
 * @param {number} width
 * @param {number} height
 * @param {{r:number, g:number, b:number, a?:number}} colour
 * @returns {Buffer}
 */
function solidPng(width, height, colour) {
  const png = new PNG({ width, height });
  const a = colour.a ?? 255;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;
      png.data[idx]     = colour.r;
      png.data[idx + 1] = colour.g;
      png.data[idx + 2] = colour.b;
      png.data[idx + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

/**
 * Build a PNG where a percentage of pixels is different colour.
 * @param {number} width
 * @param {number} height
 * @param {{r:number, g:number, b:number}} base
 * @param {{r:number, g:number, b:number}} overlay
 * @param {number} overlayRatio 0..1 — fraction of rows coloured with `overlay`.
 * @returns {Buffer}
 */
function splitPng(width, height, base, overlay, overlayRatio) {
  const png = new PNG({ width, height });
  const splitRow = Math.floor(height * (1 - overlayRatio));
  for (let y = 0; y < height; y++) {
    const colour = y < splitRow ? base : overlay;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;
      png.data[idx]     = colour.r;
      png.data[idx + 1] = colour.g;
      png.data[idx + 2] = colour.b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function ensureTestRow(db, testId) {
  // Create a minimal `tests` row so the FK on baseline_screenshots is satisfied.
  // Values match schema defaults where possible; only NOT NULL columns matter.
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tests (id, projectId, name, createdAt, updatedAt, reviewStatus)
    VALUES (?, ?, ?, ?, ?, 'pending')
    ON CONFLICT(id) DO NOTHING
  `).run(testId, "PRJ-VR-TEST", "Visual regression fixture", now, now);
}

// ── Setup ────────────────────────────────────────────────────────────────────

const db = getDatabase();
// Make sure the tests table exists; some migrations assume other tables too.
// Create a fixture project row to satisfy FK on tests(projectId).
db.prepare(`
  INSERT INTO projects (id, name, url, createdAt, status)
  VALUES ('PRJ-VR-TEST', 'Visual Regression Test Project', 'https://example.com', ?, 'idle')
  ON CONFLICT(id) DO NOTHING
`).run(new Date().toISOString());

ensureTestRow(db, "TC-VR-1");
ensureTestRow(db, "TC-VR-2");

// Clean any leftover artifacts from a previous run so tests are deterministic.
for (const id of ["TC-VR-1", "TC-VR-2"]) {
  const dir = path.join(BASELINES_DIR, id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ── baselineRepo tests ───────────────────────────────────────────────────────

console.log("\n🧪 baselineRepo");

await test("get() returns undefined when no baseline exists", () => {
  assert.equal(baselineRepo.get("TC-VR-1", 0), undefined);
});

await test("upsert() inserts a new row and get() returns it", () => {
  baselineRepo.upsert({
    testId: "TC-VR-1",
    stepNumber: 0,
    imagePath: "/artifacts/baselines/TC-VR-1/step-0.png",
    width: 10,
    height: 10,
  });
  const row = baselineRepo.get("TC-VR-1", 0);
  assert.ok(row, "row should exist after upsert");
  assert.equal(row.testId, "TC-VR-1");
  assert.equal(row.stepNumber, 0);
  assert.equal(row.width, 10);
  assert.equal(row.height, 10);
});

await test("upsert() updates an existing row and refreshes updatedAt", async () => {
  const before = baselineRepo.get("TC-VR-1", 0);
  // Wait a millisecond so the ISO timestamp differs.
  await new Promise((r) => setTimeout(r, 5));
  baselineRepo.upsert({
    testId: "TC-VR-1",
    stepNumber: 0,
    imagePath: "/artifacts/baselines/TC-VR-1/step-0.png",
    width: 20,
    height: 20,
  });
  const after = baselineRepo.get("TC-VR-1", 0);
  assert.equal(after.width, 20, "upsert should update dimensions");
  assert.notEqual(after.updatedAt, before.updatedAt, "updatedAt should change on upsert");
  assert.equal(after.createdAt, before.createdAt, "createdAt should be preserved");
});

await test("getAllByTestId() orders by stepNumber", () => {
  baselineRepo.upsert({
    testId: "TC-VR-1",
    stepNumber: 2,
    imagePath: "/artifacts/baselines/TC-VR-1/step-2.png",
    width: 10, height: 10,
  });
  baselineRepo.upsert({
    testId: "TC-VR-1",
    stepNumber: 1,
    imagePath: "/artifacts/baselines/TC-VR-1/step-1.png",
    width: 10, height: 10,
  });
  const rows = baselineRepo.getAllByTestId("TC-VR-1");
  assert.deepEqual(rows.map(r => r.stepNumber), [0, 1, 2]);
});

await test("deleteOne() removes a single (testId, stepNumber) row", () => {
  const removed = baselineRepo.deleteOne("TC-VR-1", 2);
  assert.equal(removed, 1);
  assert.equal(baselineRepo.get("TC-VR-1", 2), undefined);
  assert.ok(baselineRepo.get("TC-VR-1", 0));
});

await test("deleteByTestId() removes all rows for a test", () => {
  const removed = baselineRepo.deleteByTestId("TC-VR-1");
  assert.ok(removed >= 1, `expected at least one row removed, got ${removed}`);
  assert.equal(baselineRepo.getAllByTestId("TC-VR-1").length, 0);
});

// ── visualDiff tests ─────────────────────────────────────────────────────────

console.log("\n🧪 visualDiff");

await test("diffScreenshot() rejects an empty buffer with status=error", () => {
  const res = diffScreenshot({
    runId: "RUN-TEST-1",
    testId: "TC-VR-2",
    stepNumber: 0,
    pngBuffer: Buffer.alloc(0),
  });
  assert.equal(res.status, "error");
  assert.match(res.message, /empty/i);
});

await test("diffScreenshot() creates a baseline on first run", () => {
  const buf = solidPng(20, 20, { r: 255, g: 0, b: 0 });
  const res = diffScreenshot({
    runId: "RUN-TEST-2",
    testId: "TC-VR-2",
    stepNumber: 0,
    pngBuffer: buf,
  });
  assert.equal(res.status, "baseline_created");
  assert.ok(res.baselinePath?.includes("TC-VR-2"));
  // Baseline PNG + DB row should now exist.
  const absPath = path.join(BASELINES_DIR, "TC-VR-2", "step-0.png");
  assert.ok(fs.existsSync(absPath), `baseline PNG should exist at ${absPath}`);
  assert.ok(baselineRepo.get("TC-VR-2", 0), "baseline DB row should exist");
});

await test("baselinePath and diffPath contain raw testId (no %-encoding) for filesystem-URL parity", () => {
  // Reviewer's concern: encodeURIComponent(testId) in the filename writes
  // `%XX` bytes to disk, but Express URL-decodes the path before
  // filesystem / HMAC lookup — producing a 404 / invalid signature.
  const buf = splitPng(20, 20, { r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 }, 0.5);
  const res = diffScreenshot({
    runId: "RUN-ENC",
    testId: "TC-VR-2",
    stepNumber: 0,
    pngBuffer: buf,
  });
  assert.ok(res.baselinePath, "baselinePath should be present");
  assert.ok(res.diffPath, "diffPath should be present");
  assert.ok(!res.baselinePath.includes("%"), `baselinePath must not contain %-encoded bytes: ${res.baselinePath}`);
  assert.ok(!res.diffPath.includes("%"), `diffPath must not contain %-encoded bytes: ${res.diffPath}`);
  // The on-disk file must match the URL path segment 1:1 after stripping the
  // `/artifacts/diffs/` prefix.
  const diskName = path.basename(res.diffPath);
  assert.ok(fs.existsSync(path.join(DIFFS_DIR, diskName)), `diff PNG should exist on disk at ${diskName}`);
});

await test("diffScreenshot() returns status=match when the capture is identical", () => {
  const buf = solidPng(20, 20, { r: 255, g: 0, b: 0 });
  const res = diffScreenshot({
    runId: "RUN-TEST-3",
    testId: "TC-VR-2",
    stepNumber: 0,
    pngBuffer: buf,
  });
  assert.equal(res.status, "match");
  assert.equal(res.diffPixels, 0);
  assert.ok(res.diffPath?.endsWith(".png"));
});

await test("diffScreenshot() flags a regression when pixels differ beyond the threshold", () => {
  // Change ~50% of rows to blue — well above the default 2% threshold.
  const buf = splitPng(20, 20, { r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 }, 0.5);
  const res = diffScreenshot({
    runId: "RUN-TEST-4",
    testId: "TC-VR-2",
    stepNumber: 0,
    pngBuffer: buf,
  });
  assert.equal(res.status, "regression");
  assert.ok(res.diffPixels > 0, "should report non-zero diffPixels");
  assert.ok(res.diffRatio > 0.02, `diffRatio ${res.diffRatio} should exceed 2%`);
  assert.ok(res.diffPath && fs.existsSync(path.join(DIFFS_DIR, path.basename(res.diffPath))),
    "diff PNG should be written to artifacts/diffs/");
});

await test("diffScreenshot() short-circuits with status=error on dimension mismatch", () => {
  // The baseline is 20×20; feed a 10×10 capture.
  const buf = solidPng(10, 10, { r: 255, g: 0, b: 0 });
  const res = diffScreenshot({
    runId: "RUN-TEST-5",
    testId: "TC-VR-2",
    stepNumber: 0,
    pngBuffer: buf,
  });
  assert.equal(res.status, "error");
  assert.match(res.message, /dimensions differ/i);
});

await test("acceptBaseline() promotes a source PNG to the new baseline and refreshes updatedAt", async () => {
  // Write a "new" capture to disk at an arbitrary path and promote it.
  const newCapturePath = path.join(TMP_DIR, "accepted.png");
  fs.writeFileSync(newCapturePath, solidPng(20, 20, { r: 0, g: 255, b: 0 }));

  const before = baselineRepo.get("TC-VR-2", 0);
  await new Promise((r) => setTimeout(r, 5));

  const res = acceptBaseline({
    testId: "TC-VR-2",
    stepNumber: 0,
    sourceAbsPath: newCapturePath,
  });
  assert.ok(res.baselinePath);

  const after = baselineRepo.get("TC-VR-2", 0);
  assert.notEqual(after.updatedAt, before.updatedAt, "updatedAt should change after accept");

  // Diffing the new baseline against itself should now match.
  const res2 = diffScreenshot({
    runId: "RUN-TEST-6",
    testId: "TC-VR-2",
    stepNumber: 0,
    pngBuffer: solidPng(20, 20, { r: 0, g: 255, b: 0 }),
  });
  assert.equal(res2.status, "match");
});

// ── Cleanup ──────────────────────────────────────────────────────────────────

for (const id of ["TC-VR-1", "TC-VR-2"]) {
  const dir = path.join(BASELINES_DIR, id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n⚠️  Visual regression tests failed");
  process.exit(1);
}

console.log("\n🎉 All visual-regression tests passed!");
