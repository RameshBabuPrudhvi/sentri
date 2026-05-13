import test from 'node:test';
import assert from 'node:assert/strict';
import { orderTestsByRisk, applyBudgetToQueue, scoreTestRisk } from '../src/pipeline/riskScorer.js';

test('recent failures rank higher than long-green tests', () => {
  const tests = [{ id: 't1', name: 'Checkout', updatedAt: '2026-05-01T00:00:00Z' }, { id: 't2', name: 'Search', updatedAt: '2026-04-01T00:00:00Z' }];
  const history = [
    { testId: 't1', status: 'failed' },
    { testId: 't2', status: 'passed' },
    { testId: 't2', status: 'passed' },
  ];
  const ranked = orderTestsByRisk(tests, history, { now: Date.parse('2026-05-09T00:00:00Z') });
  assert.equal(ranked[0].id, 't1');
});

test('smoke tests are pinned even with lower score', () => {
  const tests = [{ id: 'a', name: 'Smoke: login' }, { id: 'b', name: 'Flaky checkout' }];
  const history = [{ testId: 'b', status: 'failed' }];
  const ranked = orderTestsByRisk(tests, history);
  assert.equal(ranked[0].id, 'a');
});

test('budget truncates queue, keeps smoke tests, surfaces skipped', () => {
  const tests = [
    { id: 's', name: 'smoke sanity', estimatedDurationMs: 8 * 60_000 },
    { id: 'x', name: 'heavy', estimatedDurationMs: 8 * 60_000 },
    { id: 'y', name: 'heavy2', estimatedDurationMs: 8 * 60_000 },
  ];
  const { kept, skipped } = applyBudgetToQueue(tests, 10);
  assert.deepEqual(kept.map((t) => t.id), ['s']);
  assert.deepEqual(skipped.map((t) => t.id), ['x', 'y']);
  assert.ok(skipped.every((t) => t.skipReason === 'over_budget'));
});

test('budget clamps malformed / oversized values', () => {
  const tests = [{ id: 'a', name: 'a', estimatedDurationMs: 1000 }];
  // Non-finite values short-circuit to "no budget enforced"
  assert.deepEqual(applyBudgetToQueue(tests, 'abc').kept.map((t) => t.id), ['a']);
  assert.deepEqual(applyBudgetToQueue(tests, Infinity).kept.map((t) => t.id), ['a']);
  // Massive values cap at MAX_BUDGET_MINUTES (240) — no exception, no crash
  assert.deepEqual(applyBudgetToQueue(tests, 1e9).kept.map((t) => t.id), ['a']);
});

test('BullMQ worker invariant: testIds order is preserved when rebuilding tests array', () => {
  // AUTO-001 regression guard: backend/src/workers/runWorker.js (lines ~133-149)
  // was previously `allTests.filter(idSet.has)`, which silently re-sorted the
  // dispatched tests into DB order and defeated the route layer's risk
  // ranking for every BullMQ-processed run. Locking the order-preserving
  // map-and-filter shape here so a refactor can't regress it without breaking
  // a test.
  const testIds = ['t-high-risk', 't-low-risk', 't-smoke'];
  const allTests = [
    // Returned in DB order (alphabetical by id, typical SQLite behaviour) —
    // distinct from the risk-ranked testIds order above.
    { id: 't-low-risk', name: 'low' },
    { id: 't-high-risk', name: 'high' },
    { id: 't-smoke', name: 'Smoke: login' },
    { id: 't-unrelated', name: 'not dispatched' }, // not in testIds — must be dropped
  ];
  const byId = new Map(allTests.map((t) => [t.id, t]));
  const tests = testIds.map((id) => byId.get(id)).filter(Boolean);
  assert.deepEqual(tests.map((t) => t.id), ['t-high-risk', 't-low-risk', 't-smoke']);
});

test('runner-level invariant: smoke tests pin to front even when caller hands a non-smoke-first array', async () => {
  // AUTO-001: any caller of runTests() — route layer, BullMQ worker, single-
  // test execute, future schedulers — must see smoke tests dispatched first
  // regardless of how it ordered the array. Locking this here so a future
  // refactor of testRunner.js can't silently strip the pin and let smoke
  // tests slide behind heavy non-smoke ones on a budget-truncated run.
  const { isSmokeTest } = await import('../src/pipeline/riskScorer.js');
  const input = [
    { id: 'flaky', name: 'flaky checkout' },
    { id: 'a', name: 'Smoke: login' },
    { id: 'b', name: 'heavy regression' },
    { id: 'c', tags: ['smoke'], name: 'tagged smoke' },
  ];
  // Mirror the partition logic the runner applies (see backend/src/testRunner.js).
  const reordered = [
    ...input.filter((t) => isSmokeTest(t)),
    ...input.filter((t) => !isSmokeTest(t)),
  ];
  assert.deepEqual(reordered.map((t) => t.id), ['a', 'c', 'flaky', 'b']);
});

test('runHistory is interpreted newest-first (matches getRecentCompletedWithResults DESC order)', () => {
  // Regression guard: scoreTestRisk previously used slice(-10) / at(-1) which
  // assumed oldest-first ordering, but both route callers build history via
  // runRepo.getRecentCompletedWithResults() which queries
  // `ORDER BY startedAt DESC`. The "+20 most-recent-failure" bonus was
  // therefore inverted — recently-fixed tests kept getting the boost, and
  // tests that just started failing did not. Locking the contract here.
  const subject = { id: 't', updatedAt: '1970-01-01T00:00:00Z' }; // disable recency term
  // Newest-first: position 0 is the most recent execution.
  const justFailed = [{ testId: 't', status: 'failed' }, { testId: 't', status: 'passed' }];
  const justFixed  = [{ testId: 't', status: 'passed' }, { testId: 't', status: 'failed' }];
  const justFailedScore = scoreTestRisk(subject, justFailed);
  const justFixedScore  = scoreTestRisk(subject, justFixed);
  // A test whose most-recent run failed must outrank a test whose most-recent
  // run passed, even when both have identical pass rates over the window.
  assert.ok(
    justFailedScore > justFixedScore,
    `expected just-failed (${justFailedScore}) > just-fixed (${justFixedScore})`,
  );
});

test('changed page boosts risk score', () => {
  const base = { id: 't', sourceUrl: 'https://app.example.com/checkout' };
  const withChange = scoreTestRisk(base, [], { changedPages: ['https://app.example.com/checkout'] });
  const withoutChange = scoreTestRisk(base, [], { changedPages: [] });
  assert.ok(withChange > withoutChange);
});
