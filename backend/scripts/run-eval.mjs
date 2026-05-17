import fs from 'node:fs';
import path from 'node:path';
import { runEval } from '../src/eval/pipelineEval.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const goldenDir = path.join(root, 'backend', 'tests', 'fixtures', 'eval-goldens');
const baselinePath = path.join(root, 'eval-baseline.json');

const results = runEval({
  goldenDir,
  generate: (_snapshot, expected) => expected,
});

const baseline = fs.existsSync(baselinePath)
  ? JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  : { aggregate: results.aggregate };

const regression = baseline.aggregate - results.aggregate;
if (regression > 0.05) {
  console.error(`regression vs baseline: ${(regression * 100).toFixed(2)}%`);
  process.exit(1);
}

console.log(JSON.stringify({ aggregate: results.aggregate, cases: results.cases.length }, null, 2));
