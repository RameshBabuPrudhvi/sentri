import { getDatabase } from "../sqlite.js";

const DEFAULT_MAX_BYTES = 64 * 1024;

function nowIso() { return new Date().toISOString(); }
function maxBytes() {
  const n = Number(process.env.AGENT_THREAD_STATE_MAX_BYTES || DEFAULT_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}
function serializeState(state) {
  const json = JSON.stringify(state ?? {});
  if (Buffer.byteLength(json, "utf8") > maxBytes()) {
    const err = new Error("agent_thread_state exceeds size budget");
    err.code = "ERR_AGENT_THREAD_STATE_TOO_LARGE";
    throw err;
  }
  return json;
}
function parseRow(row) {
  return row ? { ...row, state: JSON.parse(row.state) } : null;
}

export function get(threadId, workspaceId) {
  const row = getDatabase().prepare("SELECT * FROM agent_thread_state WHERE threadId = ? AND workspaceId = ?").get(threadId, workspaceId);
  return parseRow(row);
}

export function setKey(threadId, workspaceId, key, value) {
  const curr = get(threadId, workspaceId);
  const state = { ...(curr?.state || {}) };
  state[key] = value;
  const stateJson = serializeState(state);
  const ts = nowIso();
  const db = getDatabase();
  if (!curr) {
    db.prepare("INSERT INTO agent_thread_state (threadId, workspaceId, state, version, updatedAt) VALUES (?, ?, ?, ?, ?)")
      .run(threadId, workspaceId, stateJson, 1, ts);
    return get(threadId, workspaceId);
  }
  db.prepare("UPDATE agent_thread_state SET state = ?, version = ?, updatedAt = ? WHERE threadId = ? AND workspaceId = ?")
    .run(stateJson, curr.version + 1, ts, threadId, workspaceId);
  return get(threadId, workspaceId);
}

export function casUpdate(threadId, workspaceId, expectedVersion, updater) {
  const curr = get(threadId, workspaceId) || { threadId, workspaceId, state: {}, version: 0 };
  if (curr.version !== Number(expectedVersion)) {
    const err = new Error("version mismatch");
    err.code = "ERR_AGENT_THREAD_STATE_VERSION_MISMATCH";
    err.status = 409;
    throw err;
  }
  const nextState = updater ? updater({ ...curr.state }) : curr.state;
  const stateJson = serializeState(nextState || {});
  const nextVersion = curr.version + 1;
  const ts = nowIso();
  const db = getDatabase();
  if (curr.version === 0) {
    db.prepare("INSERT INTO agent_thread_state (threadId, workspaceId, state, version, updatedAt) VALUES (?, ?, ?, ?, ?)")
      .run(threadId, workspaceId, stateJson, nextVersion, ts);
  } else {
    const info = db.prepare("UPDATE agent_thread_state SET state = ?, version = ?, updatedAt = ? WHERE threadId = ? AND workspaceId = ? AND version = ?")
      .run(stateJson, nextVersion, ts, threadId, workspaceId, curr.version);
    if (!info.changes) {
      const err = new Error("version mismatch");
      err.code = "ERR_AGENT_THREAD_STATE_VERSION_MISMATCH";
      err.status = 409;
      throw err;
    }
  }
  return get(threadId, workspaceId);
}
