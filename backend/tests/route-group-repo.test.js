/**
 * @module tests/route-group-repo
 * @description PR #29 — Unit coverage for `routeGroupRepo` (B4.6 read-only
 * data-access layer for `route_groups` + `route_group_members`).
 *
 * REVIEW.md mandates "new repository module → unit tests for every
 * exported function". Covers `list` / `getById` / `listMembers` plus the
 * workspace-scoping invariant every repo in this codebase must enforce.
 *
 * Same test-base + DB-seed pattern as `probe-debounce.test.js`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = process.env.SENTRI_MASTER_KEY
  || Buffer.alloc(32, 7).toString("base64");

const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");
const routeGroupRepo = await import("../src/database/repositories/routeGroupRepo.js");
const providerRouteRepo = await import("../src/database/repositories/providerRouteRepo.js");

getDatabase();
const { test, summary } = createTestRunner();
const now = () => new Date().toISOString();

// ── Seed helpers ──────────────────────────────────────────────────────────────
function seedWorkspace() {
  const db = getDatabase();
  const userId = `usr-${randomUUID().slice(0, 8)}`;
  const wsId = `ws-${randomUUID().slice(0, 8)}`;
  db.prepare(
    "INSERT INTO users (id, name, email, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(userId, `Test ${userId}`, `${userId}@test.local`, "x", now(), now());
  db.prepare(
    "INSERT INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(wsId, `ws-${wsId}`, wsId, userId, now(), now());
  return { wsId, userId };
}

function insertRoute(workspaceId, overrides = {}) {
  // skipAutoProbe: true to avoid fire-and-forget probes racing assertions.
  return providerRouteRepo.upsert({
    workspaceId,
    name: overrides.name || `route-${randomUUID().slice(0, 8)}`,
    family: overrides.family || "openai",
    protocol: overrides.protocol || "openai",
    model: overrides.model || "gpt-4o-mini",
    enabled: overrides.enabled ?? 1,
    capabilities: overrides.capabilities,
    skipAutoProbe: true,
  });
}

/**
 * Insert a `route_groups` row directly via SQL — the repo is read-only by
 * design (see module JSDoc), so tests seed via raw SQL the same way
 * `probe-debounce.test.js` seeds users + workspaces.
 */
function insertGroup(workspaceId, overrides = {}) {
  const db = getDatabase();
  const id = overrides.id || `rg-${randomUUID()}`;
  db.prepare(
    "INSERT INTO route_groups (id, workspaceId, name, strategy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    workspaceId,
    overrides.name || `group-${randomUUID().slice(0, 8)}`,
    overrides.strategy || "weighted",
    now(),
    now(),
  );
  return { id };
}

function insertMember(groupId, routeId, weight = 1) {
  const db = getDatabase();
  const id = `rgm-${randomUUID()}`;
  db.prepare(
    "INSERT INTO route_group_members (id, groupId, routeId, weight, createdAt) VALUES (?, ?, ?, ?, ?)",
  ).run(id, groupId, routeId, weight, now());
  return { id };
}

// ── 1. list() — basic shape + ordering ────────────────────────────────────────
console.log("\n🧪 routeGroupRepo.list — basic shape");

test("list returns [] for a workspace with no groups", () => {
  const { wsId } = seedWorkspace();
  assert.deepEqual(routeGroupRepo.list(wsId), []);
});

test("list returns groups ordered by name ASC", () => {
  const { wsId } = seedWorkspace();
  insertGroup(wsId, { name: "zebra" });
  insertGroup(wsId, { name: "alpha" });
  insertGroup(wsId, { name: "mango" });
  const names = routeGroupRepo.list(wsId).map((g) => g.name);
  assert.deepEqual(names, ["alpha", "mango", "zebra"]);
});

test("list carries strategy + timestamps + workspaceId per row", () => {
  const { wsId } = seedWorkspace();
  insertGroup(wsId, { name: "cheap-tier", strategy: "cost" });
  const [row] = routeGroupRepo.list(wsId);
  assert.equal(row.strategy, "cost");
  assert.equal(row.workspaceId, wsId);
  assert.ok(row.createdAt, "createdAt present");
  assert.ok(row.updatedAt, "updatedAt present");
});

// ── 2. list() — aggregate counts ──────────────────────────────────────────────
console.log("\n🧪 routeGroupRepo.list — member-count aggregates");

test("memberCount + enabledMemberCount are 0 for an empty group (LEFT JOIN safety)", () => {
  const { wsId } = seedWorkspace();
  insertGroup(wsId, { name: "empty-group" });
  const [row] = routeGroupRepo.list(wsId);
  // LEFT JOIN means an empty group must still appear — and counts must
  // be 0, not null. The COALESCE in the repo's SUM(...) guards this.
  assert.equal(row.memberCount, 0);
  assert.equal(row.enabledMemberCount, 0);
});

test("memberCount counts every member; enabledMemberCount excludes disabled routes", () => {
  const { wsId } = seedWorkspace();
  const group = insertGroup(wsId, { name: "mixed" });
  const r1 = insertRoute(wsId, { enabled: 1 });
  const r2 = insertRoute(wsId, { enabled: 1 });
  const r3 = insertRoute(wsId, { enabled: 0 }); // disabled
  insertMember(group.id, r1.id);
  insertMember(group.id, r2.id);
  insertMember(group.id, r3.id);
  const [row] = routeGroupRepo.list(wsId);
  assert.equal(row.memberCount, 3, "all three members count");
  assert.equal(row.enabledMemberCount, 2, "only the two enabled count toward healthy");
});

// ── 3. getById() — happy path + cross-workspace ───────────────────────────────
console.log("\n🧪 routeGroupRepo.getById — workspace scoping");

test("getById returns the row when workspaceId matches", () => {
  const { wsId } = seedWorkspace();
  const { id } = insertGroup(wsId, { name: "myGroup", strategy: "latency" });
  const row = routeGroupRepo.getById(wsId, id);
  assert.ok(row, "row returned");
  assert.equal(row.id, id);
  assert.equal(row.name, "myGroup");
  assert.equal(row.strategy, "latency");
});

test("getById returns undefined when the id belongs to ANOTHER workspace (no existence leak)", () => {
  const { wsId: wsA } = seedWorkspace();
  const { wsId: wsB } = seedWorkspace();
  const { id } = insertGroup(wsA, { name: "secret-tier" });
  // wsB asks for wsA's id — must look like the row doesn't exist.
  const row = routeGroupRepo.getById(wsB, id);
  assert.equal(row, undefined, "cross-workspace lookup must return undefined, not the row");
});

test("getById returns undefined for an unknown id in the correct workspace", () => {
  const { wsId } = seedWorkspace();
  const row = routeGroupRepo.getById(wsId, "rg-does-not-exist");
  assert.equal(row, undefined);
});

// ── 4. listMembers() — hydration + workspace scoping ──────────────────────────
console.log("\n🧪 routeGroupRepo.listMembers — hydration + scoping");

test("listMembers returns [] for an empty group", () => {
  const { wsId } = seedWorkspace();
  const { id } = insertGroup(wsId);
  assert.deepEqual(routeGroupRepo.listMembers(wsId, id), []);
});

test("listMembers hydrates the joined provider_routes row", () => {
  const { wsId } = seedWorkspace();
  const group = insertGroup(wsId);
  const route = insertRoute(wsId, {
    name: "anth-1",
    family: "anthropic",
    protocol: "anthropic",
    model: "claude-3-5-sonnet-20241022",
  });
  insertMember(group.id, route.id, 5);
  const members = routeGroupRepo.listMembers(wsId, group.id);
  assert.equal(members.length, 1);
  const m = members[0];
  assert.equal(m.groupId, group.id);
  assert.equal(m.routeId, route.id);
  assert.equal(m.weight, 5);
  // Hydrated route shape — pulled from provider_routes via the JOIN.
  assert.equal(m.route.id, route.id);
  assert.equal(m.route.family, "anthropic");
  assert.equal(m.route.model, "claude-3-5-sonnet-20241022");
  assert.equal(m.route.enabled, true, "enabled hydrated as boolean (1 -> true)");
});

test("listMembers parses route.capabilities JSON string into an object", () => {
  const { wsId } = seedWorkspace();
  const group = insertGroup(wsId);
  // Persist via the repo so capabilities is stringified on write the same
  // way production data lands in the column.
  const caps = { reachable: true, auth: true, model: true, jsonMode: true };
  const route = insertRoute(wsId, { capabilities: caps });
  insertMember(group.id, route.id);
  const [member] = routeGroupRepo.listMembers(wsId, group.id);
  assert.deepEqual(
    member.route.capabilities,
    caps,
    "capabilities round-tripped through JSON.parse on read",
  );
});

test("listMembers route.capabilities is null when the column is empty", () => {
  const { wsId } = seedWorkspace();
  const group = insertGroup(wsId);
  // No capabilities passed — column stays NULL, safeParse should return null.
  const route = insertRoute(wsId);
  insertMember(group.id, route.id);
  const [member] = routeGroupRepo.listMembers(wsId, group.id);
  assert.equal(member.route.capabilities, null);
});

test("listMembers cross-workspace returns [] (workspace scope enforced via JOIN)", () => {
  const { wsId: wsA } = seedWorkspace();
  const { wsId: wsB } = seedWorkspace();
  const groupA = insertGroup(wsA);
  const routeA = insertRoute(wsA);
  insertMember(groupA.id, routeA.id);
  // wsB asks for wsA's group id — JOIN to route_groups filters it out.
  const members = routeGroupRepo.listMembers(wsB, groupA.id);
  assert.deepEqual(members, [], "cross-workspace member fetch must return empty array");
});

// ── 5. Workspace isolation regression ─────────────────────────────────────────
console.log("\n🧪 routeGroupRepo — workspace isolation");

test("two workspaces with the same group name don't see each other's rows in list()", () => {
  const { wsId: wsA } = seedWorkspace();
  const { wsId: wsB } = seedWorkspace();
  // Same human name in both — the UNIQUE(workspaceId, name) constraint
  // permits this because workspaceId differs. Confirms list() filters
  // strictly by the predicate.
  insertGroup(wsA, { name: "cheap-tier" });
  insertGroup(wsB, { name: "cheap-tier" });
  const listA = routeGroupRepo.list(wsA);
  const listB = routeGroupRepo.list(wsB);
  assert.equal(listA.length, 1);
  assert.equal(listB.length, 1);
  assert.equal(listA[0].workspaceId, wsA);
  assert.equal(listB[0].workspaceId, wsB);
  assert.notEqual(listA[0].id, listB[0].id, "must be distinct rows");
});

summary("Route Group Repo (PR #29)");
