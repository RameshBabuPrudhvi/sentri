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

export function purgeOlderThan(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const cutoff = new Date(Date.now() - d * 86400000).toISOString();
  const result = getDatabase().prepare("DELETE FROM agent_messages WHERE createdAt < ?").run(cutoff);
  return result.changes || 0;
}
