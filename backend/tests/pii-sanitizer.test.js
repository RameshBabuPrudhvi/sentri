/**
 * @file Tests for the SEC-006 PII firewall (`pipeline/domSanitizer.js`).
 *
 * Covers pattern coverage, Luhn validation, deterministic placeholders
 * (within and across calls sharing a context), per-category sequences,
 * exact-value allowlist matching, recursive walking of nested values,
 * the `pipeline.pii_redacted` audit log shape, and the `total` aggregate
 * (which must NOT double-count `jwt` / `bearer` / `queryAuth` — those are
 * subdivisions of `token`).
 *
 * Follows project conventions: Node built-in `assert/strict`, synchronous
 * `test()` runner, `process.exit(1)` on failure (mirrors secret-scanner.test.js).
 */

import assert from "node:assert/strict";
import {
  sanitizeDomSnapshot,
  createPiiContext,
  finalizePiiContext,
} from "../src/pipeline/domSanitizer.js";
import { createTestRunner } from "./helpers/test-base.js";

// Stage 2 (test-infra cleanup) — replaced the inline `function test(name, fn)`
// with the shared runner from `helpers/test-base.js`. The runner needs
// `console.log` working to print its pass/fail lines, so we no longer
// globally silence `console.log` at file load (the previous pattern broke
// the runner's output). Instead, `silenceLogs()` is called inside each
// test body that doesn't already use `withLogCapture()`, and unconditionally
// restored in a `try/finally` so per-test silencing can't leak into the
// next test's runner output.
const realConsoleLog = console.log;
const { test, summary } = createTestRunner();

/** Run `fn` with `console.log` silenced; restore on exit. */
function silenceLogs(fn) {
  console.log = () => {};
  try { return fn(); } finally { console.log = realConsoleLog; }
}

function withLogCapture(fn) {
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    fn(lines);
  } finally {
    console.log = realConsoleLog;
  }
}

// ── Pattern coverage ───────────────────────────────────────────────────────

test("redacts emails", () => {
  const { output, counts } = sanitizeDomSnapshot("Contact alice@example.com today.");
  assert.equal(output, "Contact <EMAIL_1> today.");
  assert.equal(counts.email, 1);
});

test("redacts US phone numbers (dashed, dotted, parenthesised, E.164)", () => {
  const inputs = [
    "Call 415-555-1212 now",
    "Call 415.555.1212 now",
    "Call (415) 555-1212 now",
    "Call +1 415 555 1212 now",
  ];
  for (const s of inputs) {
    const { output, counts } = sanitizeDomSnapshot(s);
    assert.match(output, /<PHONE_\d+>/, `should redact phone in: ${s}`);
    assert.equal(counts.phone, 1);
  }
});

test("redacts SSN-shaped 3-2-4 sequences", () => {
  const { output, counts } = sanitizeDomSnapshot("SSN: 123-45-6789");
  assert.equal(output, "SSN: <SSN_1>");
  assert.equal(counts.ssn, 1);
});

test("does NOT redact non-SSN dash patterns", () => {
  const { output, counts } = sanitizeDomSnapshot("ID 1234-56-789 here");
  assert.ok(!/<SSN_/.test(output));
  assert.equal(counts.ssn, 0);
});

test("redacts Luhn-valid credit card numbers", () => {
  // 4111 1111 1111 1111 is the canonical Luhn-valid Visa test PAN.
  const { output, counts } = sanitizeDomSnapshot("Card: 4111 1111 1111 1111");
  assert.match(output, /<CARD_\d+>/);
  assert.equal(counts.card, 1);
});

test("does NOT redact Luhn-INVALID 13–19 digit sequences", () => {
  // 4111 1111 1111 1112 fails Luhn — must pass through untouched.
  const { output, counts } = sanitizeDomSnapshot("Junk: 4111 1111 1111 1112");
  assert.equal(output, "Junk: 4111 1111 1111 1112");
  assert.equal(counts.card, 0);
});

test("does NOT redact digit runs outside the 13–19 length window", () => {
  const short = sanitizeDomSnapshot("Number 123456789012 here");
  const long = sanitizeDomSnapshot("Number 12345678901234567890 here");
  assert.equal(short.counts.card, 0);
  assert.equal(long.counts.card, 0);
});

test("redacts JWTs and counts under both jwt and token", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123";
  const { output, counts } = sanitizeDomSnapshot(`header ${jwt} tail`);
  assert.match(output, /<TOKEN_\d+>/);
  assert.equal(counts.jwt, 1);
  assert.equal(counts.token, 1);
});

test("redacts Bearer / Basic Authorization headers", () => {
  const bearer = sanitizeDomSnapshot("Authorization: Bearer abc.def-ghi");
  const basic = sanitizeDomSnapshot("Authorization: Basic dXNlcjpwYXNz");
  assert.match(bearer.output, /<TOKEN_\d+>/);
  assert.match(basic.output, /<TOKEN_\d+>/);
  assert.equal(bearer.counts.bearer, 1);
  assert.equal(basic.counts.bearer, 1);
});

test("redacts auth query params and preserves siblings", () => {
  const { output, counts } = sanitizeDomSnapshot(
    "https://x/cb?token=abc123&foo=bar&code=xyz789&access_token=qqq&keep=me",
  );
  assert.match(output, /foo=bar/);
  assert.match(output, /keep=me/);
  assert.match(output, /token=<TOKEN_\d+>/);
  assert.match(output, /code=<TOKEN_\d+>/);
  assert.match(output, /access_token=<TOKEN_\d+>/);
  assert.equal(counts.queryAuth, 3);
  assert.equal(counts.token, 3);
});

// ── Determinism ────────────────────────────────────────────────────────────

test("identical inputs in the SAME call resolve to the same placeholder", () => {
  const { output } = sanitizeDomSnapshot("Email a@b.com twice: a@b.com and a@b.com.");
  const matches = output.match(/<EMAIL_\d+>/g) || [];
  assert.equal(matches.length, 3);
  assert.ok(matches.every((m) => m === matches[0]));
});

test("emails differing only by case map to the SAME placeholder", () => {
  // Email keys are lower-cased before lookup so `A@B.com` and `a@b.com`
  // resolve to the same placeholder — preserves the AI's ability to
  // correlate references that differ only by display casing.
  const { output } = sanitizeDomSnapshot("A@B.com vs a@b.com");
  const matches = output.match(/<EMAIL_\d+>/g) || [];
  assert.equal(matches.length, 2);
  assert.equal(matches[0], matches[1]);
});

test("identical inputs across TWO calls sharing a context produce the same placeholder", () => {
  const ctx = createPiiContext({ runId: "RUN-T1" });
  const a = sanitizeDomSnapshot("Email a@b.com on page 1", ctx);
  const b = sanitizeDomSnapshot("Email a@b.com on page 2", ctx);
  const idA = a.output.match(/<EMAIL_\d+>/)[0];
  const idB = b.output.match(/<EMAIL_\d+>/)[0];
  assert.equal(idA, idB, "shared context must reuse the same placeholder ID");
});

test("FRESH one-shot contexts are independent — counters do not pollute each other", () => {
  const a = sanitizeDomSnapshot("Email a@b.com");
  const b = sanitizeDomSnapshot("Email a@b.com");
  assert.equal(a.output, "Email <EMAIL_1>");
  assert.equal(b.output, "Email <EMAIL_1>");
  assert.notStrictEqual(a.ctx, b.ctx);
});

// ── Per-category sequences ─────────────────────────────────────────────────

test("each category has its own counter (EMAIL_1/2, PHONE_1 — not EMAIL_1/PHONE_2)", () => {
  const { output } = sanitizeDomSnapshot("a@b.com / c@d.com / 415-555-1212");
  assert.match(output, /<EMAIL_1>/);
  assert.match(output, /<EMAIL_2>/);
  assert.match(output, /<PHONE_1>/);
});

// ── Allowlist (exact-value, case-insensitive) ──────────────────────────────

test("allowlist exempts an exact email and still redacts non-allowlisted ones", () => {
  const { output, counts } = sanitizeDomSnapshot(
    "Keep demo@example.com but redact other@example.com",
    { allowlist: ["demo@example.com"] },
  );
  assert.match(output, /demo@example\.com/);
  assert.match(output, /<EMAIL_\d+>/);
  assert.equal(counts.email, 1);
});

test("allowlist match is case-insensitive", () => {
  const { output } = sanitizeDomSnapshot(
    "DEMO@Example.COM stays here",
    { allowlist: ["demo@example.com"] },
  );
  assert.match(output, /DEMO@Example\.COM/);
});

test("allowlist does NOT exempt substrings (no silent footgun)", () => {
  // Under the old `.includes()` allowlist, a short entry like "5551212"
  // would have exempted every phone number containing those digits. The
  // exact-match semantics close that footgun — the full phone is still
  // redacted because the allowlist entry doesn't equal the full match.
  const { output, counts } = sanitizeDomSnapshot(
    "Call 415-555-1212 now",
    { allowlist: ["5551212"] },
  );
  assert.match(output, /<PHONE_\d+>/);
  assert.equal(counts.phone, 1);
});

// ── Recursive walking ──────────────────────────────────────────────────────

test("walks nested objects and arrays", () => {
  const input = {
    title: "Contact alice@example.com",
    items: ["bob@example.com", { note: "ssn 123-45-6789" }],
    nested: { deep: { phone: "Call 415-555-1212" } },
  };
  const { output, counts } = sanitizeDomSnapshot(input);
  assert.match(output.title, /<EMAIL_\d+>/);
  assert.match(output.items[0], /<EMAIL_\d+>/);
  assert.match(output.items[1].note, /<SSN_\d+>/);
  assert.match(output.nested.deep.phone, /<PHONE_\d+>/);
  assert.equal(counts.email, 2);
  assert.equal(counts.ssn, 1);
  assert.equal(counts.phone, 1);
});

test("passes through null / undefined / numbers / booleans / empty strings untouched", () => {
  const input = { a: null, b: undefined, c: 42, d: true, e: "" };
  const { output } = sanitizeDomSnapshot(input);
  assert.equal(output.a, null);
  assert.equal(output.b, undefined);
  assert.equal(output.c, 42);
  assert.equal(output.d, true);
  assert.equal(output.e, "");
});

// ── Audit log shape ────────────────────────────────────────────────────────

test("one-shot form emits a single `pipeline.pii_redacted` log per call", () => {
  withLogCapture((lines) => {
    sanitizeDomSnapshot("Email a@b.com", { runId: "RUN-LOG-1" });
    const piiLines = lines.filter((l) => l.includes("pipeline.pii_redacted"));
    assert.equal(piiLines.length, 1, `expected 1 log line, got ${piiLines.length}: ${lines.join(" | ")}`);
    assert.ok(piiLines[0].includes("RUN-LOG-1"));
  });
});

test("shared-context form emits ZERO logs until finalizePiiContext is called", () => {
  withLogCapture((lines) => {
    const ctx = createPiiContext({ runId: "RUN-LOG-2" });
    sanitizeDomSnapshot("Email a@b.com", ctx);
    sanitizeDomSnapshot("Email c@d.com", ctx);
    assert.equal(
      lines.filter((l) => l.includes("pipeline.pii_redacted")).length,
      0,
      "shared-context calls must not emit logs themselves",
    );
    finalizePiiContext(ctx);
    const after = lines.filter((l) => l.includes("pipeline.pii_redacted"));
    assert.equal(after.length, 1, "finalize must emit exactly one log");
    assert.ok(after[0].includes("RUN-LOG-2"));
  });
});

test("`total` excludes jwt/bearer/queryAuth (already counted in token)", () => {
  // One JWT + one Bearer + one query-auth param = `token=3`. The aggregate
  // total must equal 3 (not 3+1+1+1 = 6) — otherwise dashboards over-report.
  withLogCapture((lines) => {
    sanitizeDomSnapshot(
      "Bearer abc.def-ghi and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF and ?token=xyz",
      { runId: "RUN-LOG-3" },
    );
    const line = lines.find((l) => l.includes("pipeline.pii_redacted"));
    assert.ok(line, `expected a pii_redacted log, got: ${lines.join(" | ")}`);
    // The log format is either JSON (LOG_JSON=true) or kv-pairs. Extract the
    // `total=N` value regardless of which formatter ran.
    const totalMatch = line.match(/total[":=\s]+(\d+)/);
    assert.ok(totalMatch, `could not find total in: ${line}`);
    assert.equal(Number(totalMatch[1]), 3);
  });
});

summary("pii-sanitizer");
