/**
 * B3.3 — `agent_configs.maxReviewRounds` per-workspace override.
 *
 * Pins the repo-layer clamp into `[1, HARD_MAX_REVIEW_ROUNDS=10]` and the
 * loop's resolution order (caller > workspace override > default).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../src/database/sqlite.js";
import * as agentConfigRepo from "../src/database/repositories/agentConfigRepo.js";
import { runReviewerAuthorLoop } from "../src/aiProvider/agentLoop.js";

// Boot DB so migrations create `agent_configs` + `workspaces`.
getDatabase();

const now = () => new Date().toISOString();

function seedWorkspace() {
  const db = getDatabase();
  const userId = `usr-${randomUUID().slice(0, 8)}`;
  const wsId = `ws-${randomUUID().slice(0, 8)}`;
  const t = now();
  db.prepare(
    "INSERT INTO users (id, name, email, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(userId, `Test ${userId}`, `${userId}@test.local`, "x", t, t);
  db.prepare(
    "INSERT INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(wsId, `ws-${wsId}`, wsId, userId, t, t);
  return wsId;
}

function seedConfig(workspaceId, role, maxReviewRounds) {
  const t = now();
  return agentConfigRepo.upsert({
    id: `ac-${randomUUID()}`,
    workspaceId,
    role,
    routeId: null,
    systemPromptOverride: null,
    temperature: 0.2,
    maxTokens: null,
    maxReviewRounds,
    createdAt: t,
    updatedAt: t,
  });
}

test("repo clamps maxReviewRounds into [1, 10]", () => {
  // Three successive seedConfig calls intentionally target the SAME
  // (workspaceId, "reviewer") tuple to exercise `agentConfigRepo.upsert`'s
  // `ON CONFLICT(workspaceId, role) DO UPDATE` path defined in
  // `backend/src/database/migrations/046_agent_configs.sql` (UNIQUE
  // index) + `backend/src/database/repositories/agentConfigRepo.js:91-100`.
  // The contract under test is: the clamp at the repo layer runs on every
  // write, not just on initial INSERT — so an operator who first sets 5,
  // then attempts 999, must end up at 10 (not the prior 5). Pinning the
  // UPDATE path explicitly here means a future refactor that drops
  // ON CONFLICT (e.g. switching to a separate `update()` path) would
  // fail this assertion instead of silently regressing the clamp.
  const wsId = seedWorkspace();
  seedConfig(wsId, "reviewer", 999);
  assert.equal(agentConfigRepo.getMaxReviewRounds(wsId, "reviewer"), 10, "clamped to hard cap on INSERT");
  seedConfig(wsId, "reviewer", 0);
  assert.equal(agentConfigRepo.getMaxReviewRounds(wsId, "reviewer"), 1, "clamped to floor on ON CONFLICT UPDATE");
  seedConfig(wsId, "reviewer", 5);
  assert.equal(agentConfigRepo.getMaxReviewRounds(wsId, "reviewer"), 5, "valid value preserved on ON CONFLICT UPDATE");
});

test("repo getMaxReviewRounds returns null when row missing", () => {
  const wsId = seedWorkspace();
  assert.equal(agentConfigRepo.getMaxReviewRounds(wsId, "reviewer"), null);
});

test("loop honours per-workspace maxReviewRounds override when caller omits it", async () => {
  const wsId = seedWorkspace();
  seedConfig(wsId, "reviewer", 2);
  // Reviewer always asks to revise — loop must terminate at max_rounds=2
  // (the workspace override), not the DEFAULT_MAX_REVIEW_ROUNDS of 3.
  const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    workspaceId: wsId,
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async () => ({ intent: "request_revision", artifact: { issues: [{ testId: "t1", problem: "x" }] } }),
  });
  assert.equal(out.outcome, "max_rounds");
  assert.equal(out.roundsCompleted, 2, "ran exactly 2 rounds per workspace override");
});

test("loop caller-supplied maxReviewRounds wins over workspace override", async () => {
  const wsId = seedWorkspace();
  seedConfig(wsId, "reviewer", 5);
  const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    workspaceId: wsId,
    maxReviewRounds: 1, // explicit caller value
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async () => ({ intent: "request_revision", artifact: { issues: [{ testId: "t1", problem: "x" }] } }),
  });
  assert.equal(out.outcome, "max_rounds");
  assert.equal(out.roundsCompleted, 1, "caller value 1 wins over workspace override 5");
});
