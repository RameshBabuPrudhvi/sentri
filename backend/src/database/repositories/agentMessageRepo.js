import { getDatabase } from "../sqlite.js";

function parseRow(row) {
  return {
    ...row,
    artifact: row.artifact == null ? null : (() => { try { return JSON.parse(row.artifact); } catch { return row.artifact; } })(),
  };
}

export function append(message) {
  const db = getDatabase();
  db.prepare(`INSERT INTO agent_messages
    (id, runId, threadId, traceId, fromRole, toRole, replyToId, intent, artifact, rationale, round, workspaceId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      message.id,
      message.runId,
      message.threadId,
      message.traceId,
      message.fromRole,
      message.toRole ?? null,
      message.replyToId ?? null,
      message.intent,
      message.artifact == null ? null : JSON.stringify(message.artifact),
      message.rationale ?? null,
      message.round ?? 0,
      message.workspaceId,
      message.createdAt,
    );
}

export function listByThread(threadId, workspaceId, toRole = null) {
  const db = getDatabase();
  if (toRole == null) {
    return db.prepare(`SELECT * FROM agent_messages WHERE threadId = ? AND workspaceId = ? ORDER BY createdAt ASC, id ASC`)
      .all(threadId, workspaceId).map(parseRow);
  }
  return db.prepare(`SELECT * FROM agent_messages WHERE threadId = ? AND workspaceId = ? AND (toRole IS NULL OR toRole = ?) ORDER BY createdAt ASC, id ASC`)
    .all(threadId, workspaceId, toRole).map(parseRow);
}

export function listByRun(runId, workspaceId) {
  return getDatabase().prepare(`SELECT * FROM agent_messages WHERE runId = ? AND workspaceId = ? ORDER BY createdAt ASC, id ASC`)
    .all(runId, workspaceId).map(parseRow);
}

export function getById(id, workspaceId) {
  const row = getDatabase().prepare(`SELECT * FROM agent_messages WHERE id = ? AND workspaceId = ?`).get(id, workspaceId);
  return row ? parseRow(row) : undefined;
}

/**
 * Hard-delete every envelope row for a run. Called from `runRepo.hardDeleteById`
 * when a run is permanently purged (recycle-bin purge / project hard-delete /
 * GDPR Article 17 erasure) so the per-thread envelope history is removed
 * alongside the run + log + agent-event rows. Mirrors
 * `runAgentEventRepo.deleteByRunId` — same append-only, no-FK-to-runs contract.
 *
 * @param {string} runId
 * @returns {number} Rows deleted.
 */
export function deleteByRunId(runId) {
  if (!runId) return 0;
  const info = getDatabase().prepare("DELETE FROM agent_messages WHERE runId = ?").run(runId);
  return info.changes || 0;
}

/**
 * Batch sibling of {@link deleteByRunId} for project-level purges and the
 * GDPR account-erasure path. Mirrors `runAgentEventRepo.deleteByRunIds`.
 *
 * @param {string[]} runIds
 * @returns {number} Total rows deleted.
 */
export function deleteByRunIds(runIds) {
  if (!runIds || runIds.length === 0) return 0;
  const placeholders = runIds.map(() => "?").join(", ");
  const info = getDatabase()
    .prepare(`DELETE FROM agent_messages WHERE runId IN (${placeholders})`)
    .run(...runIds);
  return info.changes || 0;
}

export function purgeOlderThan(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const cutoff = new Date(Date.now() - d * 86400000).toISOString();
  const result = getDatabase().prepare("DELETE FROM agent_messages WHERE createdAt < ?").run(cutoff);
  return result.changes || 0;
}
