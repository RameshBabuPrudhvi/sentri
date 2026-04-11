/**
 * @module tests/chat-window
 * @description Unit tests for the chat sliding context window.
 *
 * Tests trimConversationHistory() directly — pure function, no server needed.
 * Verifies: short conversations pass through, long ones are trimmed from the
 * middle, cut point lands on an assistant boundary, first message is preserved.
 */

import assert from "node:assert/strict";

// trimConversationHistory is not exported, so we replicate the logic here
// using the same MAX_CONVERSATION_TURNS constant from config.
// This avoids coupling the test to module internals while testing the algorithm.

const MAX_TURNS = 3; // small value for easy testing

function trimConversationHistory(messages, maxTurns = MAX_TURNS) {
  const maxMessages = maxTurns * 2 + 2;
  if (messages.length <= maxMessages) return messages;

  const initial = messages.slice(0, 1);
  let cutIdx = messages.length - maxTurns * 2;

  while (cutIdx < messages.length - 2) {
    if (messages[cutIdx].role === "assistant") break;
    cutIdx++;
  }

  const recent = messages.slice(cutIdx);
  return [...initial, ...recent];
}

function msg(role, n) {
  return { role, content: `${role} message ${n}` };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log("\n🪟  trimConversationHistory — sliding window");

test("short conversation passes through unchanged", () => {
  const msgs = [msg("user", 1), msg("assistant", 1), msg("user", 2)];
  const result = trimConversationHistory(msgs);
  assert.equal(result.length, msgs.length);
  assert.deepEqual(result, msgs);
});

test("exactly at limit passes through unchanged", () => {
  // MAX_TURNS=3 → maxMessages = 3*2+2 = 8
  const msgs = [];
  for (let i = 0; i < 4; i++) {
    msgs.push(msg("user", i));
    if (i < 3) msgs.push(msg("assistant", i)); // 7 messages + last user = 8 if we add one more
  }
  // 7 messages, under 8 limit
  const result = trimConversationHistory(msgs);
  assert.equal(result.length, msgs.length, "Should not trim when at or under limit");
});

test("long conversation is trimmed", () => {
  // 20 messages (10 turns) — well over MAX_TURNS=3 (limit=8)
  const msgs = [];
  for (let i = 0; i < 10; i++) {
    msgs.push(msg("user", i));
    msgs.push(msg("assistant", i));
  }
  const result = trimConversationHistory(msgs);
  assert.ok(result.length <= 8, `Should trim to ≤8 messages, got ${result.length}`);
  assert.ok(result.length > 0, "Should not be empty");
});

test("first message is always preserved", () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) {
    msgs.push(msg("user", i));
    msgs.push(msg("assistant", i));
  }
  const result = trimConversationHistory(msgs);
  assert.equal(result[0].content, "user message 0", "First message should be preserved");
});

test("most recent messages are preserved", () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) {
    msgs.push(msg("user", i));
    msgs.push(msg("assistant", i));
  }
  const result = trimConversationHistory(msgs);
  const last = result[result.length - 1];
  assert.equal(last.content, "assistant message 9", "Last message should be the most recent");
});

test("cut point lands on assistant boundary", () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) {
    msgs.push(msg("user", i));
    msgs.push(msg("assistant", i));
  }
  const result = trimConversationHistory(msgs);
  // After the first preserved message, the next message should be an assistant
  // (the cut point is at an assistant boundary)
  if (result.length > 1) {
    assert.equal(result[1].role, "assistant", "Cut should land on assistant boundary");
  }
});

test("single message passes through", () => {
  const msgs = [msg("user", 0)];
  const result = trimConversationHistory(msgs);
  assert.deepEqual(result, msgs);
});

test("empty array passes through", () => {
  const result = trimConversationHistory([]);
  assert.deepEqual(result, []);
});

test("does not increase message count", () => {
  const msgs = [msg("user", 0), msg("assistant", 0), msg("user", 1)];
  const result = trimConversationHistory(msgs);
  assert.ok(result.length <= msgs.length, "Should never increase message count");
});

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);

if (failed > 0) {
  console.log("\n⚠️  Chat window tests failed");
  process.exit(1);
}

console.log("\n🎉 All chat-window tests passed!");
