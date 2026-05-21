import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "crypto";
import { getDatabase } from "../src/database/sqlite.js";
import * as workspaceRepo from "../src/database/repositories/workspaceRepo.js";

const db = getDatabase();

test("agent_configs routeId can be backfilled to real provider_routes row", () => {
  const ws = workspaceRepo.createWorkspace({ name: `ws-${randomUUID()}`, slug: `ws-${randomUUID().slice(0,8)}`, createdBy: "u" });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO agent_configs (id, workspaceId, role, provider, model, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`ac-${randomUUID()}`, ws.id, "planner", "openai", "gpt-4o-mini", now, now);

  const row = db.prepare("SELECT id, workspaceId, provider, model, role FROM agent_configs WHERE workspaceId = ?").get(ws.id);
  const routeId = `pr-${randomUUID()}`;
  db.prepare(`INSERT INTO provider_routes (id, workspaceId, name, family, protocol, model, enabled, cacheEnabled, cacheTtlSec, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)`)
    .run(routeId, ws.id, "route-test", row.provider, "openai", row.model, now, now);
  db.prepare("UPDATE agent_configs SET routeId = ? WHERE id = ?").run(routeId, row.id);

  const check = db.prepare("SELECT routeId FROM agent_configs WHERE id = ?").get(row.id);
  assert.equal(check.routeId, routeId);
});
