/**
 * @module tests/validate-request
 * @description §17 #7 / TD-017 — Branch coverage for the Zod request-validation
 * middleware factory. Pins the wire-format error shape, parsed-replace
 * contract on success, and the registration-time guard against non-Zod
 * schemas. No Express dependency — exercises the middleware directly with
 * mock req/res/next so the test stays fast and framework-agnostic.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  validateBody,
  validateQuery,
  validateParams,
  z,
} from "../src/middleware/validateRequest.js";

/** Minimal Express-shaped response mock that captures status + JSON body. */
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("validateBody — passes valid body and replaces req.body with parsed shape", () => {
  const schema = z.object({ name: z.string().min(1), age: z.number().int() });
  const mw = validateBody(schema);
  const req = { body: { name: "alice", age: 30, extra: "stripped" } };
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true, "next() should be called on success");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(req.body, { name: "alice", age: 30 }, "extra keys should be stripped");
});

test("validateBody — rejects with 400 + validation_failed shape on bad input", () => {
  const schema = z.object({ name: z.string().min(1), url: z.string().url() });
  const mw = validateBody(schema);
  const req = { body: { name: "", url: "not-a-url" } };
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false, "next() must NOT be called when validation fails");
  assert.equal(res.statusCode, 400);
  // `error` carries the first issue's human-readable message so frontend
  // consumers that display `body.error` directly get actionable text.
  assert.equal(res.body.error, res.body.details[0].message);
  assert.equal(res.body.code, "validation_failed", "machine code stays available under `code`");
  assert.equal(res.body.message, "Request body failed schema validation");
  assert.ok(Array.isArray(res.body.details), "details must be an array");
  assert.ok(res.body.details.length >= 2, "both invalid fields should be reported");
  for (const issue of res.body.details) {
    assert.ok(typeof issue.path === "string" && issue.path.startsWith("body."));
    assert.ok(typeof issue.message === "string");
    assert.ok(typeof issue.code === "string");
  }
});

test("validateBody — issue path prefixes include the location segment", () => {
  const schema = z.object({ inner: z.object({ field: z.string() }) });
  const mw = validateBody(schema);
  const req = { body: { inner: { field: 123 } } };
  const res = mockRes();
  mw(req, res, () => { throw new Error("next should not run"); });

  assert.equal(res.statusCode, 400);
  const paths = res.body.details.map((d) => d.path);
  assert.ok(paths.includes("body.inner.field"), `expected nested path, got ${JSON.stringify(paths)}`);
});

test("validateQuery — coerces string-typed query params via z.coerce", () => {
  const schema = z.object({ page: z.coerce.number().int().min(1) });
  const mw = validateQuery(schema);
  const req = { query: { page: "5" } };
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.query.page, 5, "string '5' should be coerced to number 5");
});

test("validateQuery — rejects with location=query in details paths", () => {
  const schema = z.object({ page: z.coerce.number().int().min(1) });
  const mw = validateQuery(schema);
  const req = { query: { page: "0" } };
  const res = mockRes();
  mw(req, res, () => { throw new Error("next should not run"); });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.details[0].path, "query.page");
});

test("validateParams — pins UUID-shaped path params and rejects malformed", () => {
  const schema = z.object({ id: z.string().uuid() });
  const mw = validateParams(schema);

  const goodReq = { params: { id: "550e8400-e29b-41d4-a716-446655440000" } };
  const goodRes = mockRes();
  let goodNext = false;
  mw(goodReq, goodRes, () => { goodNext = true; });
  assert.equal(goodNext, true);

  const badReq = { params: { id: "not-a-uuid" } };
  const badRes = mockRes();
  mw(badReq, badRes, () => { throw new Error("next should not run"); });
  assert.equal(badRes.statusCode, 400);
  assert.equal(badRes.body.details[0].path, "params.id");
});

test("validateBody — throws at registration time when handed a non-Zod schema", () => {
  // Common foot-gun: caller forgets the `z.object(...)` wrapper and passes a
  // bare `{ name: z.string() }` literal. Without the registration-time guard
  // every request would silently pass (no .safeParse method, no validation).
  assert.throws(
    () => validateBody({ name: z.string() }),
    /not a Zod schema/,
  );
  assert.throws(() => validateBody(null), /not a Zod schema/);
  assert.throws(() => validateBody(undefined), /not a Zod schema/);
});

test("z.preprocess on optional enum — `null` / `\"\"` coerce to default, valid value passes through", () => {
  // Pins the workspaces.js `InviteMemberSchema` pattern: a frontend
  // dropdown with no selection sends `role: null` / `role: ""`; the
  // schema must default these to "viewer" (matching the pre-Zod
  // `role || "viewer"` falsy-fallback contract) instead of returning a
  // `validation_failed` 400. `z.preprocess` is the documented Zod
  // pattern for this — `.default()` alone only triggers on `undefined`.
  const schema = z.object({
    role: z.preprocess(
      (v) => (v === null || v === "" ? undefined : v),
      z.enum(["admin", "viewer"]).default("viewer"),
    ),
  });
  const mw = validateBody(schema);

  for (const payload of [{}, { role: undefined }, { role: null }, { role: "" }]) {
    const req = { body: { ...payload } };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, `should pass for payload ${JSON.stringify(payload)}`);
    assert.equal(req.body.role, "viewer", `should default to "viewer" for ${JSON.stringify(payload)}`);
  }

  // Valid explicit value still passes through unchanged.
  const goodReq = { body: { role: "admin" } };
  const goodRes = mockRes();
  let goodNext = false;
  mw(goodReq, goodRes, () => { goodNext = true; });
  assert.equal(goodNext, true);
  assert.equal(goodReq.body.role, "admin");

  // Genuinely invalid value still fails.
  const badReq = { body: { role: "owner" } };
  const badRes = mockRes();
  mw(badReq, badRes, () => { throw new Error("next should not run"); });
  assert.equal(badRes.statusCode, 400);
});

test("response details array excludes vendor internals (unionErrors, expected, received)", () => {
  const schema = z.object({ kind: z.union([z.literal("a"), z.literal("b")]) });
  const mw = validateBody(schema);
  const req = { body: { kind: "c" } };
  const res = mockRes();
  mw(req, res, () => { throw new Error("next should not run"); });

  assert.equal(res.statusCode, 400);
  const issue = res.body.details[0];
  // We deliberately only expose path / message / code. Zod's raw issue object
  // can carry `unionErrors`, `expected`, `received` — leaking those is a
  // schema-disclosure risk + bloats the payload.
  assert.deepEqual(Object.keys(issue).sort(), ["code", "message", "path"]);
});
