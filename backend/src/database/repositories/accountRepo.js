/**
 * @module database/repositories/accountRepo
 * @description Account-level data export and cascade deletion (SEC-003).
 *
 * Encapsulates the workspace-scoped queries needed for GDPR/CCPA data
 * portability (export) and right-to-erasure (deletion).  All DB access
 * goes through this module — route handlers never write raw SQL.
 */

import { getDatabase } from "../sqlite.js";
import * as userRepo from "./userRepo.js";
import * as runLogRepo from "./runLogRepo.js";
// Task 2 — per-agent SSE events. Same cascade contract as `run_logs`:
// no FK constraint at the DB layer, so the deletion path must purge
// `run_agent_events` explicitly to avoid orphan rows surviving an
// account-level GDPR erasure.
import * as runAgentEventRepo from "./runAgentEventRepo.js";
// AUTO-023 B1.1 — per-thread agent envelopes. Same cascade + export
// contract as `run_agent_events`: no FK to `runs`, so erasure must purge
// `agent_messages` explicitly and Article 20 data-portability must include
// the envelope history alongside the runs they belong to.
import * as agentMessageRepo from "./agentMessageRepo.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a comma-separated placeholder string for a parameterised IN clause.
 *
 * @param {string[]} ids
 * @returns {string} e.g. `"?, ?, ?"`
 */
function placeholders(ids) {
  return ids.map(() => "?").join(", ");
}

// ─── Export ───────────────────────────────────────────────────────────────────

/**
 * Build a JSON-serialisable export payload for all data owned by a user.
 *
 * Scope:
 * - User profile (sensitive fields stripped)
 * - Workspaces owned by the user
 * - Workspace memberships
 * - Projects, tests, runs, activities in owned workspaces
 * - Notification settings and schedules for owned projects
 *
 * @param {string} userId
 * @returns {Object}
 */
export function buildAccountExport(userId) {
  const db = getDatabase();
  const rawUser = userRepo.getById(userId);
  // Strip sensitive fields — never expose the password hash in exports.
  const { passwordHash, ...safeUser } = rawUser || {};

  const ownedWorkspaces = db
    .prepare("SELECT * FROM workspaces WHERE ownerId = ? ORDER BY createdAt ASC")
    .all(userId);
  const ownedWorkspaceIds = ownedWorkspaces.map((w) => w.id);
  const membershipRows = db
    .prepare("SELECT * FROM workspace_members WHERE userId = ? ORDER BY joinedAt ASC")
    .all(userId);

  if (ownedWorkspaceIds.length === 0) {
    return {
      exportedAt: new Date().toISOString(),
      user: safeUser,
      ownedWorkspaces: [],
      memberships: membershipRows,
      workspaceMembers: [],
      projects: [],
      tests: [],
      runs: [],
      runLogs: [],
      // Task 2 — mirror the `runLogs: []` empty-state entry so the export
      // shape is stable whether or not the user has owned workspaces.
      runAgentEvents: [],
      // AUTO-023 B1.1 — stable empty-state entry so the Article 20 export
      // shape stays consistent for users without owned workspaces.
      agentMessages: [],
      activities: [],
      notificationSettings: [],
      schedules: [],
      webhookTokens: [],
      healingHistory: [],
    };
  }

  const wsph = placeholders(ownedWorkspaceIds);
  const projects = db.prepare(`SELECT * FROM projects WHERE workspaceId IN (${wsph})`).all(...ownedWorkspaceIds);
  const projectIds = projects.map((p) => p.id);

  const tests = db.prepare(`SELECT * FROM tests WHERE workspaceId IN (${wsph})`).all(...ownedWorkspaceIds);
  const runs = db.prepare(`SELECT * FROM runs WHERE workspaceId IN (${wsph})`).all(...ownedWorkspaceIds);

  // Include run_logs (ENH-008) — log lines were moved from the runs.logs
  // JSON column to the run_logs table.  Post-migration runs have no inline
  // logs, so without this the export would be missing all log data.
  const runIds = runs.map((r) => r.id);
  let runLogs = [];
  // Task 2 — per-agent SSE events. Mirrors the runLogs export pattern so
  // GDPR Article 20 data-portability returns the agent-event history
  // alongside the runs they belong to. Without this the deletion path
  // (further down) would purge `run_agent_events` but the export would
  // silently omit them — violating the symmetry contract documented in
  // the import comment at the top of this file.
  let runAgentEvents = [];
  // AUTO-023 B1.1 — Article 20 data portability for the per-thread envelope
  // history. Same `runId IN (...)` pattern as `runLogs` / `runAgentEvents`
  // above; the deletion path below already purges this table, so omitting
  // it from the export would break the export↔erase symmetry contract.
  let agentMessages = [];
  if (runIds.length > 0) {
    const rph = placeholders(runIds);
    runLogs = db.prepare(`SELECT * FROM run_logs WHERE runId IN (${rph}) ORDER BY runId, seq ASC`).all(...runIds);
    runAgentEvents = db
      .prepare(`SELECT * FROM run_agent_events WHERE runId IN (${rph}) ORDER BY runId, createdAt ASC, id ASC`)
      .all(...runIds);
    agentMessages = db
      .prepare(`SELECT * FROM agent_messages WHERE runId IN (${rph}) ORDER BY runId, createdAt ASC, id ASC`)
      .all(...runIds);
  }

  const activities = db.prepare(`SELECT * FROM activities WHERE workspaceId IN (${wsph})`).all(...ownedWorkspaceIds);
  const workspaceMembers = db.prepare(`SELECT * FROM workspace_members WHERE workspaceId IN (${wsph})`).all(...ownedWorkspaceIds);

  let notificationSettings = [];
  let schedules = [];
  let webhookTokens = [];
  if (projectIds.length > 0) {
    const pph = placeholders(projectIds);
    notificationSettings = db.prepare(`SELECT * FROM notification_settings WHERE projectId IN (${pph})`).all(...projectIds)
      .map((row) => ({ ...row, enabled: !!row.enabled }));
    schedules = db.prepare(`SELECT * FROM schedules WHERE projectId IN (${pph})`).all(...projectIds);
    webhookTokens = db.prepare(`SELECT id, projectId, label, createdAt, lastUsedAt FROM webhook_tokens WHERE projectId IN (${pph})`).all(...projectIds);
  }

  // Collect healing_history entries for all tests in owned workspaces.
  // Keys are formatted as "<testId>::<action>::<label>".
  const testIds = tests.map((t) => t.id);
  let healingHistory = [];
  if (testIds.length > 0) {
    const clauses = [];
    const params = [];
    for (const tid of testIds) {
      clauses.push("key LIKE ?", "key LIKE ?");
      params.push(`${tid}::%`, `${tid}@v%::%`);
    }
    healingHistory = db.prepare(`SELECT * FROM healing_history WHERE ${clauses.join(" OR ")}`).all(...params);
  }

  return {
    exportedAt: new Date().toISOString(),
    user: safeUser,
    ownedWorkspaces,
    memberships: membershipRows,
    workspaceMembers,
    projects,
    tests,
    runs,
    runLogs,
    runAgentEvents,
    agentMessages,
    activities,
    notificationSettings,
    schedules,
    webhookTokens,
    healingHistory,
  };
}

// ─── Deletion ─────────────────────────────────────────────────────────────────

/**
 * Hard-delete a user account and all owned workspace data in a single
 * transaction.  This is the GDPR Article 17 "right to erasure" implementation.
 *
 * Cascade order:
 * 1. Per-project children: notification_settings, schedules, webhook_tokens
 * 2. Per-test children: healing_history
 * 3. Per-workspace children: activities, run_logs → runs, tests, projects
 * 4. Workspace membership and workspace rows
 * 5. User-level rows: workspace_members (non-owned), oauth_ids,
 *    password_reset_tokens, verification_tokens, users
 *
 * @param {string} userId
 * @throws {Error} If the transaction fails (caller should catch and 500).
 */
export function deleteAccount(userId) {
  const db = getDatabase();

  const removeAccount = db.transaction(() => {
    const ownedWorkspaceRows = db
      .prepare("SELECT id FROM workspaces WHERE ownerId = ?")
      .all(userId);
    const ownedWorkspaceIds = ownedWorkspaceRows.map((w) => w.id);

    if (ownedWorkspaceIds.length > 0) {
      const wsph = placeholders(ownedWorkspaceIds);

      // Collect owned project IDs for child-table cleanup
      const ownedProjectRows = db
        .prepare(`SELECT id FROM projects WHERE workspaceId IN (${wsph})`)
        .all(...ownedWorkspaceIds);
      const ownedProjectIds = ownedProjectRows.map((p) => p.id);

      if (ownedProjectIds.length > 0) {
        const pph = placeholders(ownedProjectIds);
        db.prepare(`DELETE FROM notification_settings WHERE projectId IN (${pph})`).run(...ownedProjectIds);
        db.prepare(`DELETE FROM schedules WHERE projectId IN (${pph})`).run(...ownedProjectIds);
        db.prepare(`DELETE FROM webhook_tokens WHERE projectId IN (${pph})`).run(...ownedProjectIds);
      }

      // Delete healing_history for all tests in owned workspaces.
      // Use direct SQL instead of healingRepo.deleteByTestIds() to avoid
      // a nested transaction (that helper wraps deletes in its own txn).
      const ownedTestRows = db.prepare(`SELECT id FROM tests WHERE workspaceId IN (${wsph})`).all(...ownedWorkspaceIds);
      const ownedTestIds = ownedTestRows.map((t) => t.id);
      if (ownedTestIds.length > 0) {
        const healStmt = db.prepare("DELETE FROM healing_history WHERE key LIKE ?");
        for (const tid of ownedTestIds) {
          healStmt.run(`${tid}::%`);
          healStmt.run(`${tid}@v%::%`);
        }
      }

      // Delete run_logs for all runs in owned workspaces
      const runRows = db.prepare(`SELECT id FROM runs WHERE workspaceId IN (${wsph})`).all(...ownedWorkspaceIds);
      const runIds = runRows.map((r) => r.id);
      if (runIds.length > 0) {
        runLogRepo.deleteByRunIds(runIds);
        // Task 2 — cascade into `run_agent_events` so the per-agent SSE
        // event history is purged alongside the logs. Mirrors the cascade
        // wired in runRepo.hardDeleteByProjectId; without it the GDPR
        // erasure path leaves orphan agent-event rows that reference a
        // deleted runId forever.
        runAgentEventRepo.deleteByRunIds(runIds);
        // AUTO-023 B1.1 — cascade into `agent_messages` so the per-thread
        // envelope history is purged alongside the runs + logs + events.
        // Mirrors `runRepo.hardDeleteByProjectId`; without this the GDPR
        // erasure path leaves orphan rows pointing at a deleted runId.
        agentMessageRepo.deleteByRunIds(runIds);
      }

      db.prepare(`DELETE FROM activities WHERE workspaceId IN (${wsph})`).run(...ownedWorkspaceIds);
      db.prepare(`DELETE FROM runs WHERE workspaceId IN (${wsph})`).run(...ownedWorkspaceIds);
      db.prepare(`DELETE FROM tests WHERE workspaceId IN (${wsph})`).run(...ownedWorkspaceIds);
      db.prepare(`DELETE FROM projects WHERE workspaceId IN (${wsph})`).run(...ownedWorkspaceIds);
      db.prepare(`DELETE FROM workspace_members WHERE workspaceId IN (${wsph})`).run(...ownedWorkspaceIds);
      db.prepare(`DELETE FROM workspaces WHERE id IN (${wsph})`).run(...ownedWorkspaceIds);
    }

    // Clean up user-level rows (non-owned workspace memberships, OAuth, tokens)
    db.prepare("DELETE FROM workspace_members WHERE userId = ?").run(userId);
    db.prepare("DELETE FROM oauth_ids WHERE userId = ?").run(userId);
    db.prepare("DELETE FROM password_reset_tokens WHERE userId = ?").run(userId);
    db.prepare("DELETE FROM verification_tokens WHERE userId = ?").run(userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  });

  removeAccount();
}
