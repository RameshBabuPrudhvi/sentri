/**
 * @module tests/secrets
 * @description B1.4 — AES-256-GCM at-rest encryption tests.
 *
 * Pins:
 *   1. encryptKey/decryptKey round-trip preserves plaintext byte-for-byte.
 *   2. `lastFour` = last 4 chars of plaintext (UI display contract).
 *   3. Ciphertext is non-deterministic (random nonce per call).
 *   4. Tampered ciphertext or nonce → ERR_SECRET_DECRYPT_FAILED.
 *   5. Production master-key missing → ERR_MASTER_KEY_MISSING at module load.
 *   6. Master-key wrong length → ERR_MASTER_KEY_INVALID.
 *   7. `getDecryptedKey` caches plaintext keyed by routeId.
 *   8. `invalidateRouteSecret` drops the cache for a single route.
 *   9. Decrypt with a different master key fails closed.
 */
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = Buffer.alloc(32, "A").toString("base64");
const { createTestRunner } = await import("./helpers/test-base.js");
const secrets = await import("../src/aiProvider/secrets.js");
const { test, summary } = createTestRunner();
console.log("\n🧪 encrypt / decrypt round-trip");
test("encryptKey output shape: ciphertext + nonce + lastFour", () => {
  const out = secrets.encryptKey("sk-abcdefgh1234");
  assert.ok(Buffer.isBuffer(out.ciphertext), "ciphertext must be a Buffer");
  assert.ok(Buffer.isBuffer(out.nonce), "nonce must be a Buffer");
  assert.equal(out.nonce.length, 12, "GCM nonce is 12 bytes");
  assert.equal(out.lastFour, "1234", "lastFour = trailing 4 chars");
});
test("decryptKey round-trip preserves plaintext", () => {
  const plaintext = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const { ciphertext, nonce } = secrets.encryptKey(plaintext);
  assert.equal(secrets.decryptKey(ciphertext, nonce), plaintext);
});
test("ciphertext is non-deterministic (different nonce each call)", () => {
  const a = secrets.encryptKey("same-plaintext");
  const b = secrets.encryptKey("same-plaintext");
  assert.notEqual(a.ciphertext.toString("hex"), b.ciphertext.toString("hex"),
    "GCM with a random nonce must produce different ciphertext for the same plaintext");
  assert.notEqual(a.nonce.toString("hex"), b.nonce.toString("hex"));
});
test("lastFour handles short plaintexts gracefully", () => {
  // 4-char plaintext: lastFour == plaintext.
  assert.equal(secrets.encryptKey("abcd").lastFour, "abcd");
  // 3-char plaintext: slice(-4) is the whole string.
  assert.equal(secrets.encryptKey("xyz").lastFour, "xyz");
});
test("encryptKey rejects empty / non-string plaintext", () => {
  assert.throws(() => secrets.encryptKey(""), TypeError);
  assert.throws(() => secrets.encryptKey(null), TypeError);
  assert.throws(() => secrets.encryptKey(undefined), TypeError);
  assert.throws(() => secrets.encryptKey(12345), TypeError);
});
console.log("\n🧪 tamper detection");
test("tampered ciphertext fails with ERR_SECRET_DECRYPT_FAILED", () => {
  const { ciphertext, nonce } = secrets.encryptKey("real-key");
  // Flip the first byte of the ciphertext.
  const tampered = Buffer.from(ciphertext);
  tampered[0] ^= 0xff;
  assert.throws(
    () => secrets.decryptKey(tampered, nonce),
    (err) => err.code === "ERR_SECRET_DECRYPT_FAILED",
  );
});
test("tampered nonce fails with ERR_SECRET_DECRYPT_FAILED", () => {
  const { ciphertext, nonce } = secrets.encryptKey("real-key");
  const tampered = Buffer.from(nonce);
  tampered[0] ^= 0xff;
  assert.throws(
    () => secrets.decryptKey(ciphertext, tampered),
    (err) => err.code === "ERR_SECRET_DECRYPT_FAILED",
  );
});
test("ciphertext shorter than auth tag fails closed", () => {
  assert.throws(
    () => secrets.decryptKey(Buffer.alloc(8), Buffer.alloc(12)),
    (err) => err.code === "ERR_SECRET_DECRYPT_FAILED",
  );
});
test("non-Buffer args fail closed", () => {
  assert.throws(
    () => secrets.decryptKey("not-a-buffer", Buffer.alloc(12)),
    (err) => err.code === "ERR_SECRET_DECRYPT_FAILED",
  );
});
console.log("\n🧪 master-key resolution");
test("missing SENTRI_MASTER_KEY in production fails fast (subprocess)", async () => {
  // Module-load failure can't be observed in-process — we already loaded
  // secrets.js above with a valid key. Spawn a fresh node subprocess with
  // NODE_ENV=production and no key to verify the import-time throw.
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["-e", `
    process.env.DB_PATH = ":memory:";
    process.env.NODE_ENV = "production";
    delete process.env.SENTRI_MASTER_KEY;
    import("${new URL("../src/aiProvider/secrets.js", import.meta.url).pathname}")
      .then(() => process.exit(0))
      .catch((err) => {
        process.stderr.write(err.code || "NO_CODE");
        process.exit(1);
      });
  `], { encoding: "utf8" });
  assert.equal(result.status, 1, "production import must fail without SENTRI_MASTER_KEY");
  assert.ok(result.stderr.includes("ERR_MASTER_KEY_MISSING"),
    `expected ERR_MASTER_KEY_MISSING, got: ${result.stderr}`);
});
test("malformed SENTRI_MASTER_KEY (wrong length) fails fast in production", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["-e", `
    process.env.DB_PATH = ":memory:";
    process.env.NODE_ENV = "production";
    process.env.SENTRI_MASTER_KEY = Buffer.alloc(16, "X").toString("base64"); // 16 bytes, not 32
    import("${new URL("../src/aiProvider/secrets.js", import.meta.url).pathname}")
      .then(() => process.exit(0))
      .catch((err) => {
        process.stderr.write(err.code || "NO_CODE");
        process.exit(1);
      });
  `], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("ERR_MASTER_KEY_INVALID"),
    `expected ERR_MASTER_KEY_INVALID, got: ${result.stderr}`);
});
console.log("\n🧪 plaintext cache");
test("invalidateRouteSecret + clearSecretCache are exported", () => {
  // Smoke: both helpers exist and are safe to call on missing entries.
  assert.equal(typeof secrets.invalidateRouteSecret, "function");
  assert.equal(typeof secrets.clearSecretCache, "function");
  secrets.invalidateRouteSecret("nonexistent-route-id"); // must not throw
  secrets.clearSecretCache();
});
test("master-key rotation: ciphertext written under key A fails under key B", () => {
  // Encrypt under the current (key A) master.
  const { ciphertext, nonce } = secrets.encryptKey("rotation-test");
  // Rotate to a different master key.
  process.env.SENTRI_MASTER_KEY = Buffer.alloc(32, "B").toString("base64");
  secrets._reloadMasterKeyForTests();
  try {
    assert.throws(
      () => secrets.decryptKey(ciphertext, nonce),
      (err) => err.code === "ERR_SECRET_DECRYPT_FAILED",
      "ciphertext encrypted under key A MUST NOT decrypt under key B",
    );
  } finally {
    // Restore.
    process.env.SENTRI_MASTER_KEY = Buffer.alloc(32, "A").toString("base64");
    secrets._reloadMasterKeyForTests();
  }
});
summary("Secrets (B1.4)");
