/**
 * @module tests/openapi
 * @description Unit tests for INF-004 — OpenAPI specification structure.
 *
 * Validates the exported spec object is a well-formed OpenAPI 3.1 document
 * with the expected tags, security schemes, schemas, and path coverage.
 */

import assert from "node:assert/strict";
import { spec } from "../src/openapi.js";
import { createTestRunner } from "./helpers/test-base.js";

const { test, summary } = createTestRunner();

console.log("\n📖 INF-004: OpenAPI spec structure");

test("spec.openapi is 3.1.0", () => {
  assert.equal(spec.openapi, "3.1.0");
});

test("spec.info has title, version, and description", () => {
  assert.ok(spec.info.title, "Missing title");
  assert.ok(spec.info.version, "Missing version");
  assert.ok(spec.info.description, "Missing description");
});

test("spec.servers has at least one entry pointing to /api/v1", () => {
  assert.ok(Array.isArray(spec.servers) && spec.servers.length > 0);
  assert.ok(spec.servers.some(s => s.url === "/api/v1"), "Expected /api/v1 server");
});

test("spec.tags is a non-empty array", () => {
  assert.ok(Array.isArray(spec.tags) && spec.tags.length >= 10, `Expected >=10 tags, got ${spec.tags.length}`);
});

test("spec.tags includes Auth, Projects, Tests, Runs", () => {
  const names = spec.tags.map(t => t.name);
  for (const expected of ["Auth", "Projects", "Tests", "Runs"]) {
    assert.ok(names.includes(expected), `Missing tag: ${expected}`);
  }
});

console.log("\n📖 INF-004: security schemes");

test("cookieAuth security scheme exists", () => {
  assert.ok(spec.components.securitySchemes.cookieAuth, "Missing cookieAuth");
  assert.equal(spec.components.securitySchemes.cookieAuth.type, "apiKey");
  assert.equal(spec.components.securitySchemes.cookieAuth.in, "cookie");
  assert.equal(spec.components.securitySchemes.cookieAuth.name, "access_token");
});

test("triggerToken security scheme exists", () => {
  assert.ok(spec.components.securitySchemes.triggerToken, "Missing triggerToken");
  assert.equal(spec.components.securitySchemes.triggerToken.type, "http");
  assert.equal(spec.components.securitySchemes.triggerToken.scheme, "bearer");
});

console.log("\n📖 INF-004: component schemas");

test("Error schema has required error property", () => {
  const s = spec.components.schemas.Error;
  assert.ok(s, "Missing Error schema");
  assert.ok(s.properties.error, "Missing error property");
  assert.deepEqual(s.required, ["error"]);
});

test("Project schema has id, name, url", () => {
  const s = spec.components.schemas.Project;
  assert.ok(s, "Missing Project schema");
  assert.ok(s.properties.id);
  assert.ok(s.properties.name);
  assert.ok(s.properties.url);
});

test("Test schema has id, projectId, reviewStatus", () => {
  const s = spec.components.schemas.Test;
  assert.ok(s, "Missing Test schema");
  assert.ok(s.properties.id);
  assert.ok(s.properties.projectId);
  assert.ok(s.properties.reviewStatus);
});

test("Run schema has id, projectId, type, status", () => {
  const s = spec.components.schemas.Run;
  assert.ok(s, "Missing Run schema");
  assert.ok(s.properties.id);
  assert.ok(s.properties.projectId);
  assert.ok(s.properties.type);
  assert.ok(s.properties.status);
});

console.log("\n📖 INF-004: path coverage");

test("spec.paths has at least 30 endpoints", () => {
  const count = Object.keys(spec.paths).length;
  assert.ok(count >= 30, `Expected >=30 paths, got ${count}`);
});

test("auth endpoints are present and public (security: [])", () => {
  assert.ok(spec.paths["/auth/register"], "Missing /auth/register");
  assert.ok(spec.paths["/auth/login"], "Missing /auth/login");
  assert.deepEqual(spec.paths["/auth/register"].post.security, [], "/auth/register should be public");
  assert.deepEqual(spec.paths["/auth/login"].post.security, [], "/auth/login should be public");
});

test("project CRUD paths exist", () => {
  assert.ok(spec.paths["/projects"], "Missing /projects");
  assert.ok(spec.paths["/projects/{id}"], "Missing /projects/{id}");
  assert.ok(spec.paths["/projects"].get, "Missing GET /projects");
  assert.ok(spec.paths["/projects"].post, "Missing POST /projects");
  assert.ok(spec.paths["/projects/{id}"].get, "Missing GET /projects/{id}");
  assert.ok(spec.paths["/projects/{id}"].delete, "Missing DELETE /projects/{id}");
});

test("run endpoints exist", () => {
  assert.ok(spec.paths["/projects/{id}/crawl"], "Missing crawl");
  assert.ok(spec.paths["/projects/{id}/run"], "Missing run");
  assert.ok(spec.paths["/projects/{id}/runs"], "Missing runs list");
  assert.ok(spec.paths["/runs/{runId}"], "Missing run detail");
  assert.ok(spec.paths["/runs/{runId}/abort"], "Missing abort");
});

test("trigger endpoint uses triggerToken security", () => {
  const trigger = spec.paths["/projects/{id}/trigger"];
  assert.ok(trigger, "Missing trigger path");
  assert.ok(trigger.post.security.some(s => "triggerToken" in s), "Trigger should use triggerToken security");
});

test("POST /projects/{id}/run documents locale and timezoneId (AUTO-007)", () => {
  const run = spec.paths["/projects/{id}/run"];
  assert.ok(run.post.requestBody, "Missing requestBody on POST /projects/{id}/run");
  const props = run.post.requestBody.content["application/json"].schema.properties;
  assert.ok(props.locale, "Missing locale property");
  assert.ok(props.timezoneId, "Missing timezoneId property");
  assert.ok(props.geolocation, "Missing geolocation property");
});

summary("openapi");
