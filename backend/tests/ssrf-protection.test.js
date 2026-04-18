/**
 * @module tests/ssrf-protection
 * @description Unit tests for SSRF protection functions in utils/ssrfGuard.js.
 *
 * Verifies:
 *   - isPrivateIp correctly identifies all RFC 1918 / loopback / link-local IPs
 *   - isPrivateIp rejects cloud metadata IPs (169.254.x.x)
 *   - isPrivateIp handles IPv6 loopback, unique-local, link-local, multicast
 *   - isPrivateIp handles IPv4-mapped IPv6 (::ffff:127.0.0.1)
 *   - isPrivateIp does NOT false-positive on hostnames like "fdic.gov"
 *   - isPrivateIp returns false for public IPs
 *   - validateUrl rejects private hostnames, IPs, and non-http protocols
 *   - validateUrl accepts valid public URLs
 */

import assert from "node:assert/strict";
import { isPrivateIp, validateUrl } from "../src/utils/ssrfGuard.js";

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const deferred = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      // Async test — collect and await later
      deferred.push(result.then(() => {
        console.log(`  ✅ ${name}`);
        passed++;
      }).catch((err) => {
        console.error(`  ❌ ${name}`);
        console.error(`     ${err.message}`);
        failed++;
      }));
    } else {
      console.log(`  ✅ ${name}`);
      passed++;
    }
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ─── ipv4ToInt ────────────────────────────────────────────────────────────────

console.log("\n── ipv4ToInt ──");

test("parses 0.0.0.0 as 0", () => {
  assert.equal(ipv4ToInt("0.0.0.0"), 0);
});

test("parses 255.255.255.255 as 4294967295", () => {
  assert.equal(ipv4ToInt("255.255.255.255"), 4294967295);
});

test("parses 192.168.1.1 correctly", () => {
  assert.equal(ipv4ToInt("192.168.1.1"), 0xC0A80101);
});

test("returns null for non-IP strings", () => {
  assert.equal(ipv4ToInt("example.com"), null);
  assert.equal(ipv4ToInt("not-an-ip"), null);
});

test("returns null for partial IPs", () => {
  assert.equal(ipv4ToInt("192.168.1"), null);
});

// ─── isPrivateIp — IPv4 private ranges ────────────────────────────────────────

console.log("\n── isPrivateIp — IPv4 private ranges ──");

test("10.0.0.1 is private (10.0.0.0/8)", () => {
  assert.equal(isPrivateIp("10.0.0.1"), true);
});

test("10.255.255.255 is private (10.0.0.0/8)", () => {
  assert.equal(isPrivateIp("10.255.255.255"), true);
});

test("172.16.0.1 is private (172.16.0.0/12)", () => {
  assert.equal(isPrivateIp("172.16.0.1"), true);
});

test("172.31.255.255 is private (172.16.0.0/12)", () => {
  assert.equal(isPrivateIp("172.31.255.255"), true);
});

test("172.15.255.255 is NOT private (below 172.16.0.0/12)", () => {
  assert.equal(isPrivateIp("172.15.255.255"), false);
});

test("172.32.0.0 is NOT private (above 172.16.0.0/12)", () => {
  assert.equal(isPrivateIp("172.32.0.0"), false);
});

test("192.168.0.1 is private (192.168.0.0/16)", () => {
  assert.equal(isPrivateIp("192.168.0.1"), true);
});

test("192.168.255.255 is private (192.168.0.0/16)", () => {
  assert.equal(isPrivateIp("192.168.255.255"), true);
});

test("127.0.0.1 is private (loopback)", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
});

test("127.255.255.255 is private (loopback)", () => {
  assert.equal(isPrivateIp("127.255.255.255"), true);
});

test("169.254.169.254 is private (cloud metadata)", () => {
  assert.equal(isPrivateIp("169.254.169.254"), true);
});

test("169.254.0.1 is private (link-local)", () => {
  assert.equal(isPrivateIp("169.254.0.1"), true);
});

test("0.0.0.0 is private (0.0.0.0/8)", () => {
  assert.equal(isPrivateIp("0.0.0.0"), true);
});

// ─── isPrivateIp — public IPs ─────────────────────────────────────────────────

console.log("\n── isPrivateIp — public IPs ──");

test("8.8.8.8 is public", () => {
  assert.equal(isPrivateIp("8.8.8.8"), false);
});

test("1.1.1.1 is public", () => {
  assert.equal(isPrivateIp("1.1.1.1"), false);
});

test("93.184.216.34 is public (example.com)", () => {
  assert.equal(isPrivateIp("93.184.216.34"), false);
});

test("203.0.113.1 is public (TEST-NET-3)", () => {
  assert.equal(isPrivateIp("203.0.113.1"), false);
});

// ─── isPrivateIp — IPv6 ──────────────────────────────────────────────────────

console.log("\n── isPrivateIp — IPv6 ──");

test("::1 is private (IPv6 loopback)", () => {
  assert.equal(isPrivateIp("::1"), true);
});

test("0:0:0:0:0:0:0:1 is private (IPv6 loopback expanded)", () => {
  assert.equal(isPrivateIp("0:0:0:0:0:0:0:1"), true);
});

test("fc00::1 is private (unique-local)", () => {
  assert.equal(isPrivateIp("fc00::1"), true);
});

test("fd12:3456::1 is private (unique-local fd)", () => {
  assert.equal(isPrivateIp("fd12:3456::1"), true);
});

test("fe80::1 is private (link-local)", () => {
  assert.equal(isPrivateIp("fe80::1"), true);
});

test("ff02::1 is private (multicast)", () => {
  assert.equal(isPrivateIp("ff02::1"), true);
});

test(":: is private (unspecified)", () => {
  assert.equal(isPrivateIp("::"), true);
});

// ─── isPrivateIp — IPv4-mapped IPv6 ──────────────────────────────────────────

console.log("\n── isPrivateIp — IPv4-mapped IPv6 ──");

test("::ffff:127.0.0.1 is private", () => {
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
});

test("::ffff:192.168.1.1 is private", () => {
  assert.equal(isPrivateIp("::ffff:192.168.1.1"), true);
});

test("::ffff:169.254.169.254 is private (cloud metadata)", () => {
  assert.equal(isPrivateIp("::ffff:169.254.169.254"), true);
});

test("::ffff:8.8.8.8 is public", () => {
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
});

// ─── isPrivateIp — hostname false-positive guard ─────────────────────────────

console.log("\n── isPrivateIp — hostname false-positive guard ──");

test("fdic.gov is NOT private (hostname, not IPv6)", () => {
  assert.equal(isPrivateIp("fdic.gov"), false);
});

test("fcbarcelona.com is NOT private (hostname, not IPv6)", () => {
  assert.equal(isPrivateIp("fcbarcelona.com"), false);
});

test("ffmpeg.org is NOT private (hostname, not IPv6)", () => {
  assert.equal(isPrivateIp("ffmpeg.org"), false);
});

test("example.com is NOT private (hostname)", () => {
  assert.equal(isPrivateIp("example.com"), false);
});

test("localhost returns false from isPrivateIp (handled separately by validateUrl)", () => {
  // isPrivateIp only checks IP addresses; "localhost" is handled by the hostname check
  assert.equal(isPrivateIp("localhost"), false);
});

// ─── validateUrl ──────────────────────────────────────────────────────────────

console.log("\n── validateUrl ──");

test("validateUrl rejects non-http protocols", async () => {
  const err = await validateUrl("ftp://example.com/hook");
  assert.ok(err, "should return an error");
  assert.match(err, /http or https/i);
});

test("validateUrl rejects localhost", async () => {
  const err = await validateUrl("http://localhost:3000/hook");
  assert.ok(err, "should return an error");
  assert.match(err, /private/i);
});

test("validateUrl rejects .internal hostnames", async () => {
  const err = await validateUrl("https://myservice.internal/hook");
  assert.ok(err, "should return an error");
  assert.match(err, /private/i);
});

test("validateUrl rejects .local hostnames", async () => {
  const err = await validateUrl("https://myhost.local/hook");
  assert.ok(err, "should return an error");
  assert.match(err, /private/i);
});

test("validateUrl rejects private IPs", async () => {
  const err = await validateUrl("http://169.254.169.254/latest/meta-data/");
  assert.ok(err, "should return an error");
  assert.match(err, /private|reserved/i);
});

test("validateUrl rejects 127.0.0.1", async () => {
  const err = await validateUrl("http://127.0.0.1:8080/hook");
  assert.ok(err, "should return an error");
  assert.match(err, /private|reserved/i);
});

test("validateUrl rejects 10.x.x.x", async () => {
  const err = await validateUrl("http://10.0.0.5/hook");
  assert.ok(err, "should return an error");
  assert.match(err, /private|reserved/i);
});

test("validateUrl rejects invalid URLs", async () => {
  const err = await validateUrl("not-a-url");
  assert.ok(err, "should return an error");
  assert.match(err, /not.*valid/i);
});

test("validateUrl accepts valid public https URL", async () => {
  // DNS resolution for example.com may or may not work in CI, but the
  // protocol/hostname checks should pass.  We test the non-DNS path by
  // using a bare public IP.
  const err = await validateUrl("https://93.184.216.34/hook");
  assert.equal(err, null, "should accept a public IP URL");
});

// ─── Results ──────────────────────────────────────────────────────────────────

// Await any async tests before reporting
await Promise.all(deferred);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
