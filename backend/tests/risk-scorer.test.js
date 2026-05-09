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

test('budget truncates queue but keeps smoke tests', () => {
  const tests = [
    { id: 's', name: 'smoke sanity', estimatedDurationMs: 8 * 60_000 },
    { id: 'x', name: 'heavy', estimatedDurationMs: 8 * 60_000 },
    { id: 'y', name: 'heavy2', estimatedDurationMs: 8 * 60_000 },
  ];
  const kept = applyBudgetToQueue(tests, 10);
  assert.deepEqual(kept.map((t) => t.id), ['s']);
});

test('changed page boosts risk score', () => {
  const base = { id: 't', sourceUrl: 'https://app.example.com/checkout' };
  const withChange = scoreTestRisk(base, [], { changedPages: ['https://app.example.com/checkout'] });
  const withoutChange = scoreTestRisk(base, [], { changedPages: [] });
  assert.ok(withChange > withoutChange);
});
