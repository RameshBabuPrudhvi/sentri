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

test("askPeer timeout clears pending map", async () => {
  const before = runtime._getPendingPeerCount();
  await assert.rejects(() => runtime.executeToolCall({
    role: "author",
    tool: "thread.askPeer",
    args: { role: "reviewer", question: "q" },
    context: { workspaceId: "ws1", threadId: "th", fromRole: "author", peerQuestionTimeoutMs: 20 },
  }));
  assert.equal(runtime._getPendingPeerCount(), before);
});

test("askPeer round-trip resolves when answer arrives", async () => {
  const pending = runtime.executeToolCall({
    role: "author",
    tool: "thread.askPeer",
    args: { role: "reviewer", question: "is this valid?" },
    context: { workspaceId: "ws1", threadId: "th", fromRole: "author", runId: "r1", peerQuestionTimeoutMs: 2000 },
  });
  await new Promise((r) => setTimeout(r, 10));
  const ids = runtime._peekPendingPeerIds();
  assert.ok(ids.length > 0);
  runtime.answerPeer({ toolCallId: ids[0], answer: "yes", runId: "r1", workspaceId: "ws1", threadId: "th", fromRole: "reviewer", toRole: "author" });
  const out = await pending;
  assert.equal(out.result.answer, "yes");
});
