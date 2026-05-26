import assert from "node:assert/strict";
import test from "node:test";
import { setupTestEnvironment } from "./helpers/test-base.js";
setupTestEnvironment();

const runtime = await import("../src/aiProvider/agentTools/runtime.js");

test("askPeer self-cycle protection", async () => {
  await assert.rejects(() => runtime.executeToolCall({
    role: "author",
    tool: "thread.askPeer",
    args: { role: "author", question: "q" },
    context: { workspaceId: "ws1", threadId: "th", fromRole: "author" },
  }));
});

test("askPeer timeout", async () => {
  await assert.rejects(() => runtime.executeToolCall({
    role: "author",
    tool: "thread.askPeer",
    args: { role: "reviewer", question: "q" },
    context: { workspaceId: "ws1", threadId: "th", fromRole: "author", peerQuestionTimeoutMs: 20 },
  }));
});
