/**
 * @module tests/device-emulation
 * @description Unit tests for DIF-003 device emulation — resolveDevice() and DEVICE_PRESETS.
 */

import assert from "node:assert/strict";
import { resolveDevice, DEVICE_PRESETS } from "../src/runner/config.js";
import { createTestRunner } from "./helpers/test-base.js";

const { test, summary } = createTestRunner();

console.log("\n🧪 resolveDevice()");

test("returns null for empty string", () => {
  assert.equal(resolveDevice(""), null);
});

test("returns null for undefined", () => {
  assert.equal(resolveDevice(undefined), null);
});

test("returns null for null", () => {
  assert.equal(resolveDevice(null), null);
});

test("returns null for unknown device name", () => {
  assert.equal(resolveDevice("Nokia 3310"), null);
});

test("resolves 'iPhone 14' to a valid descriptor", () => {
  const d = resolveDevice("iPhone 14");
  assert.ok(d, "Expected a descriptor object");
  assert.ok(d.viewport, "Expected viewport");
  assert.ok(d.viewport.width > 0, "Expected positive viewport width");
  assert.ok(d.viewport.height > 0, "Expected positive viewport height");
  assert.ok(typeof d.userAgent === "string", "Expected userAgent string");
});

test("resolves 'Pixel 7' to a valid descriptor", () => {
  const d = resolveDevice("Pixel 7");
  assert.ok(d, "Expected a descriptor object");
  assert.ok(d.viewport, "Expected viewport");
  assert.ok(typeof d.userAgent === "string", "Expected userAgent string");
});

test("resolves 'Desktop Chrome HiDPI' to a valid descriptor", () => {
  const d = resolveDevice("Desktop Chrome HiDPI");
  assert.ok(d, "Expected a descriptor object");
  assert.ok(d.viewport, "Expected viewport");
});

console.log("\n🧪 DEVICE_PRESETS");

test("DEVICE_PRESETS is a non-empty array", () => {
  assert.ok(Array.isArray(DEVICE_PRESETS), "Expected array");
  assert.ok(DEVICE_PRESETS.length >= 10, `Expected at least 10 presets, got ${DEVICE_PRESETS.length}`);
});

test("first preset is Desktop (default) with empty value", () => {
  assert.equal(DEVICE_PRESETS[0].label, "Desktop (default)");
  assert.equal(DEVICE_PRESETS[0].value, "");
});

test("all non-default presets resolve to valid descriptors", () => {
  for (const preset of DEVICE_PRESETS) {
    if (!preset.value) continue; // skip "Desktop (default)"
    const d = resolveDevice(preset.value);
    assert.ok(d, `Preset "${preset.label}" (value="${preset.value}") did not resolve to a descriptor`);
  }
});

test("every preset has label and value properties", () => {
  for (const preset of DEVICE_PRESETS) {
    assert.ok(typeof preset.label === "string" && preset.label.length > 0, `Missing label`);
    assert.ok(typeof preset.value === "string", `Missing value for "${preset.label}"`);
  }
});

summary("device emulation");
