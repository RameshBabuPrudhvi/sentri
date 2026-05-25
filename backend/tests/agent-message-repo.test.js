import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as repo from "../src/database/repositories/agentMessageRepo.js";

const db = getDatabase();
db.exec("DELETE FROM agent_messages");
repo.append({id:"am-1",runId:"r1",threadId:"t1",traceId:"tr1",fromRole:"author",toRole:"reviewer",intent:"handoff",artifact:{a:1},round:0,workspaceId:"w1",createdAt:"2026-01-01T00:00:00.000Z"});
repo.append({id:"am-2",runId:"r1",threadId:"t1",traceId:"tr1",fromRole:"reviewer",toRole:null,intent:"question",artifact:null,round:1,workspaceId:"w1",createdAt:"2026-01-01T00:00:01.000Z"});
assert.equal(repo.listByThread("t1","w1").length,2);
assert.equal(repo.listByRun("r1","w1").length,2);
assert.equal(repo.listByThread("t1","other").length,0);
assert.equal(repo.getById("am-1","w1").artifact.a,1);
assert.equal(repo.purgeOlderThan(0),0);
console.log("✅ agent-message-repo.test passed");
