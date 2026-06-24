/**
 * @module tests/fake-data-generation
 * @description B6 / QAL-010 — seeded faker substitution unit coverage.
 *
 * Pins the four contract behaviours documented in
 * `utils/fakeDataGenerator.js`:
 *
 *   1. `seedForTest` is deterministic per `(runId, testId)`.
 *   2. `substitute` replaces every supported token with a non-empty string.
 *   3. Same seed → same value across multiple `createFaker()` calls.
 *   4. Different seeds → different values for the same token.
 *   5. `skipTokens` honours the fixture-handles-this-column carve-out.
 *
 * Works WITHOUT `@faker-js/faker` installed — the deterministic SHA-256
 * fallback path is the canonical CI assertion target. When the optional
 * dep IS present, the live faker path produces locale-aware values; both
 * paths satisfy the "non-empty string of correct shape" contract.
 */

import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";
import {
  createFaker,
  seedForTest,
  FAKE_DATA_TOKENS,
  SUPPORTED_LOCALES,
} from "../src/utils/fakeDataGenerator.js";

const t = createTestContext();
const { test, summary } = t.createTestRunner();

test("seedForTest is deterministic for the same (runId, testId)", () => {
  const a = seedForTest("run-1", "test-1");
  const b = seedForTest("run-1", "test-1");
  assert.equal(a, b);
});

test("seedForTest produces different seeds for different (runId, testId)", () => {
  const a = seedForTest("run-1", "test-1");
  const b = seedForTest("run-2", "test-1");
  const c = seedForTest("run-1", "test-2");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("substitute replaces every supported token with a non-empty string", async () => {
  const faker = await createFaker({ runId: "run-1", testId: "test-1" });
  for (const token of FAKE_DATA_TOKENS) {
    const out = faker.substitute(`prefix ${token} suffix`);
    assert.ok(!out.includes(token), `Token ${token} should be replaced`);
    assert.ok(out.startsWith("prefix "), `Prefix preserved for ${token}`);
    assert.ok(out.endsWith(" suffix"),  `Suffix preserved for ${token}`);
    // The replacement is a non-empty string between prefix/suffix.
    const middle = out.slice("prefix ".length, -(" suffix".length));
    assert.ok(middle.length > 0, `Replacement for ${token} is non-empty`);
  }
});

test("same seed produces same substitution across calls", async () => {
  const faker1 = await createFaker({ runId: "run-X", testId: "test-Y" });
  const faker2 = await createFaker({ runId: "run-X", testId: "test-Y" });
  // __FAKE_EMAIL__ is the most consumer-visible token; pin its determinism.
  const out1 = faker1.substitute("__FAKE_EMAIL__");
  const out2 = faker2.substitute("__FAKE_EMAIL__");
  assert.equal(out1, out2);
});

test("different runIds produce different values for the same testId", async () => {
  const faker1 = await createFaker({ runId: "run-A", testId: "test-1" });
  const faker2 = await createFaker({ runId: "run-B", testId: "test-1" });
  const out1 = faker1.substitute("__FAKE_EMAIL__");
  const out2 = faker2.substitute("__FAKE_EMAIL__");
  assert.notEqual(out1, out2);
});

test("multiple occurrences of the same token resolve to the same value", async () => {
  const faker = await createFaker({ runId: "run-1", testId: "test-1" });
  const out = faker.substitute("a=__FAKE_EMAIL__ b=__FAKE_EMAIL__ c=__FAKE_EMAIL__");
  // Extract the three replaced values; they must all equal.
  const matches = out.match(/[a-c]=(\S+)/g) || [];
  const values = matches.map((m) => m.split("=")[1]);
  assert.equal(values.length, 3);
  assert.equal(values[0], values[1]);
  assert.equal(values[1], values[2]);
});

test("different tokens resolve to different values", async () => {
  const faker = await createFaker({ runId: "run-1", testId: "test-1" });
  const email = faker.substitute("__FAKE_EMAIL__");
  const name  = faker.substitute("__FAKE_NAME__");
  const uuid  = faker.substitute("__FAKE_UUID__");
  assert.notEqual(email, name);
  assert.notEqual(email, uuid);
  assert.notEqual(name, uuid);
});

test("skipTokens leaves matching tokens untouched", async () => {
  const faker = await createFaker({
    runId: "run-1",
    testId: "test-1",
    skipTokens: ["__FAKE_EMAIL__"],
  });
  const out = faker.substitute("email=__FAKE_EMAIL__ name=__FAKE_NAME__");
  assert.ok(out.includes("__FAKE_EMAIL__"), "skipped token preserved");
  assert.ok(!out.includes("__FAKE_NAME__"), "non-skipped token replaced");
});

test("substitute on a token-free string returns the input verbatim", async () => {
  const faker = await createFaker({ runId: "run-1", testId: "test-1" });
  const input = `await page.goto('https://example.com/login');\nawait page.click('Submit');`;
  const out = faker.substitute(input);
  assert.equal(out, input);
});

test("createFaker falls back to 'en' for unknown locale without throwing", async () => {
  const faker = await createFaker({ runId: "run-1", testId: "test-1", locale: "xyz_BOGUS" });
  assert.equal(faker.locale, "en");
});

test("SUPPORTED_LOCALES is a frozen non-empty Set", () => {
  assert.ok(SUPPORTED_LOCALES instanceof Set);
  assert.ok(SUPPORTED_LOCALES.size > 0);
  assert.ok(SUPPORTED_LOCALES.has("en"));
  // `Object.freeze` on a Set freezes the object's OWN properties (you can't
  // reassign `SUPPORTED_LOCALES.has = ...`) but does NOT lock the Set's
  // internal entry list — `.add()` mutates internal slots that bypass the
  // frozen-property gate. So we verify frozen-ness via `Object.isFrozen`,
  // which is the canonical test for the const-export contract. The intent
  // here is to lock in the registry: a consumer should always read from
  // this module, not mutate the export.
  assert.ok(Object.isFrozen(SUPPORTED_LOCALES));
});

test("FAKE_DATA_TOKENS is frozen and covers the documented surface", () => {
  assert.ok(Object.isFrozen(FAKE_DATA_TOKENS));
  for (const required of ["__FAKE_EMAIL__", "__FAKE_NAME__", "__FAKE_UUID__", "__TIMESTAMP__"]) {
    assert.ok(FAKE_DATA_TOKENS.includes(required), `missing token ${required}`);
  }
});

await summary("fake-data-generation");
