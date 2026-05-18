/**
 * @module tests/vision-heal-pixelmatch
 * @description MNT-001b — `pixelmatchHeal` stage-7 sliding-window CV matcher.
 *
 * Real `pixelmatch` + `pngjs` (no stubs) so the test exercises the actual
 * decode → slide → score path. Each fixture PNG is synthesised in-memory
 * from a flat RGBA buffer so no on-disk assets are needed.
 */
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { pixelmatchHeal } from "../src/runner/visionHealAdapters.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✅ ${name}`);
      passed++;
    })
    .catch((err) => {
      console.error(`  ❌ ${name}`);
      console.error(`     ${err.stack || err.message}`);
      failed++;
    });
}

/**
 * Build a solid-coloured PNG of `w × h` and return its serialised buffer.
 */
function solidPng(w, h, [r, g, b, a] = [200, 100, 50, 255]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h * 4; i += 4) {
    png.data[i]     = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  return PNG.sync.write(png);
}

/**
 * Build a viewport PNG with a colored rectangle stamped at (x, y) of size
 * `w × h`. Background is light grey; rectangle is solid red so pixelmatch
 * sees a clear high-contrast region.
 */
function viewportWithRect({ width, height, x, y, rectW, rectH }) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height * 4; i += 4) {
    png.data[i]     = 240;
    png.data[i + 1] = 240;
    png.data[i + 2] = 240;
    png.data[i + 3] = 255;
  }
  for (let row = y; row < y + rectH; row++) {
    for (let col = x; col < x + rectW; col++) {
      const idx = (row * width + col) * 4;
      png.data[idx]     = 200;
      png.data[idx + 1] = 50;
      png.data[idx + 2] = 50;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

console.log("\n── MNT-001b pixelmatchHeal ──");

await test("identical buffers → confidence ≈ 1.0", async () => {
  const buf = solidPng(120, 80);
  // Baseline must be strictly smaller than viewport (the function refuses
  // equal-sized inputs); use a 64×40 solid crop matching the viewport's
  // colour so every window scores near-perfect.
  const baseline = solidPng(64, 40);
  const r = await pixelmatchHeal(buf, baseline, 0.85);
  assert.ok(r, "expected a match against an identical-coloured viewport");
  assert.ok(r.confidence >= 0.99, `expected confidence ≈ 1.0, got ${r.confidence}`);
  assert.ok(r.box && Number.isFinite(r.box.x) && Number.isFinite(r.box.y));
});

await test("locates a shifted rectangle in the viewport", async () => {
  const rectW = 48;
  const rectH = 24;
  const failure = viewportWithRect({ width: 320, height: 200, x: 120, y: 80, rectW, rectH });
  const baseline = (() => {
    const p = new PNG({ width: rectW, height: rectH });
    for (let i = 0; i < rectW * rectH * 4; i += 4) {
      p.data[i] = 200; p.data[i + 1] = 50; p.data[i + 2] = 50; p.data[i + 3] = 255;
    }
    return PNG.sync.write(p);
  })();
  const r = await pixelmatchHeal(failure, baseline, 0.85);
  assert.ok(r, "expected to locate the shifted rectangle");
  assert.ok(r.confidence >= 0.85);
  // Stride 8 → box.x should be within 8px of the true position (120, 80).
  assert.ok(Math.abs(r.box.x - 120) <= 8, `bbox.x off: ${r.box.x}`);
  assert.ok(Math.abs(r.box.y - 80) <= 8,  `bbox.y off: ${r.box.y}`);
});

await test("completely different images → returns null", async () => {
  const failure = solidPng(120, 80, [240, 240, 240, 255]); // light grey
  const baseline = solidPng(40, 20, [10, 10, 10, 255]);     // black
  const r = await pixelmatchHeal(failure, baseline, 0.85);
  assert.equal(r, null);
});

await test("malformed PNG buffer → returns null (no throw)", async () => {
  const r = await pixelmatchHeal(Buffer.from("not-a-png"), Buffer.from("also-not"), 0.85);
  assert.equal(r, null);
});

await test("baseline ≥ viewport → returns null", async () => {
  const failure = solidPng(80, 40);
  const oversize = solidPng(80, 40);
  const r = await pixelmatchHeal(failure, oversize, 0.85);
  assert.equal(r, null);
});

await test("null inputs → returns null", async () => {
  assert.equal(await pixelmatchHeal(null, null), null);
  assert.equal(await pixelmatchHeal(solidPng(20, 20), null), null);
  assert.equal(await pixelmatchHeal(null, solidPng(10, 10)), null);
});

await test("1280×720 viewport completes within 8s (perf budget)", async () => {
  const failure = viewportWithRect({ width: 1280, height: 720, x: 500, y: 300, rectW: 80, rectH: 32 });
  const baseline = (() => {
    const p = new PNG({ width: 80, height: 32 });
    for (let i = 0; i < 80 * 32 * 4; i += 4) {
      p.data[i] = 200; p.data[i + 1] = 50; p.data[i + 2] = 50; p.data[i + 3] = 255;
    }
    return PNG.sync.write(p);
  })();
  const t0 = Date.now();
  const r = await pixelmatchHeal(failure, baseline, 0.85);
  const elapsed = Date.now() - t0;
  assert.ok(r, "expected a match in 1280×720 viewport");
  // 8s ceiling — comfortably above the documented ~5s expectation but
  // tolerant of CI hosts with slower CPUs. Real concern is regressions
  // an order of magnitude past this.
  assert.ok(elapsed < 8000, `pixelmatchHeal took ${elapsed}ms (> 8000ms ceiling)`);
});

await test("stride adapts so 4K viewport stays under maxWindows budget", async () => {
  // 3840×2160 viewport with 32×16 baseline would yield ~32M windows at
  // stride 8 — far past the 50,000 cap. The adapter raises stride so
  // the call still completes in reasonable time.
  const failure = solidPng(3840, 2160);
  const baseline = solidPng(32, 16);
  const t0 = Date.now();
  const r = await pixelmatchHeal(failure, baseline, 0.85);
  const elapsed = Date.now() - t0;
  // Both inputs are uniform grey so confidence is ≈ 1 across every window.
  assert.ok(r, "expected stride-adapted match on uniform 4K viewport");
  assert.ok(elapsed < 10_000, `4K viewport took ${elapsed}ms — stride adaptation may be broken`);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
