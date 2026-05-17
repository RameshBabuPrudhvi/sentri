import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreCase, levenshtein } from '../src/eval/pipelineEval.js';

test('levenshtein distance works', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
});

test('scoreCase returns perfect score for identical code', () => {
  const code = "await page.getByRole('button').click();\nawait expect(page.getByText('Done')).toBeVisible();";
  const score = scoreCase(code, code);
  assert.equal(score.aggregate, 1);
});
