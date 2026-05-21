#!/usr/bin/env node
import { randomUUID } from "crypto";
import { getDatabase } from "../../sqlite.js";

const dryRun = process.argv.includes("--dry-run");
const db = getDatabase();

function protocolFor(family) {
  if (family === "google") return "gemini";
  if (family === "local") return "ollama";
  return "openai";
}

const rows = db.prepare("SELECT id, workspaceId, provider, model, role FROM agent_configs WHERE routeId IS NULL AND provider IS NOT NULL").all();
let created = 0;
let linked = 0;

const tx = db.transaction(() => {
  for (const row of rows) {
    const family = String(row.provider || "").trim();
    if (!family) continue;
    const protocol = protocolFor(family);
    const model = row.model || null;
    let route = db.prepare(`SELECT id FROM provider_routes WHERE workspaceId = ? AND family = ? AND protocol = ? AND ((model IS NULL AND ? IS NULL) OR model = ?) ORDER BY createdAt ASC LIMIT 1`).get(row.workspaceId, family, protocol, model, model);
    if (!route) {
      const routeId = `pr-${randomUUID()}`;
      const now = new Date().toISOString();
      const name = `${family}-${row.role || "agent"}-${routeId.slice(-6)}`;
      db.prepare(`INSERT INTO provider_routes (id, workspaceId, name, family, protocol, model, enabled, cacheEnabled, cacheTtlSec, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)`)
        .run(routeId, row.workspaceId, name, family, protocol, model, now, now);
      created += 1;
      route = { id: routeId };
    }
    db.prepare("UPDATE agent_configs SET routeId = ?, updatedAt = ? WHERE id = ?").run(route.id, new Date().toISOString(), row.id);
    linked += 1;
  }
});

if (!dryRun) tx();
console.log(JSON.stringify({ dryRun, scanned: rows.length, createdRoutes: created, linkedConfigs: linked }, null, 2));
