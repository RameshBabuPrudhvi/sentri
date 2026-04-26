import fs from 'node:fs';

const candidates = [
  'tests/e2e/artifacts/results.json',
  'tests/e2e/tests/e2e/artifacts/results.json',
];
const outPath = 'tests/e2e/EXECUTION_REPORT.md';

function flattenSuites(suite, acc = []) {
  for (const s of suite.suites || []) flattenSuites(s, acc);
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) {
      const status = t.results?.[0]?.status || 'unknown';
      acc.push({ title: spec.title || t.title, status });
    }
  }
  return acc;
}

let body = '# Sentri E2E Execution Report\n\n';
body += `Generated: ${new Date().toISOString()}\n\n`;

const resultsPath = candidates.find((p) => fs.existsSync(p));
if (!resultsPath) {
  body += 'No Playwright JSON results were found. Run the suite first.\n';
  fs.writeFileSync(outPath, body);
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
const tests = flattenSuites(raw);

body += '## Test Results\n\n';
body += '| Test | Status |\n|---|---|\n';
for (const t of tests) {
  const title = String(t.title || '(untitled)').replace(/\|/g, '\\|');
  body += `| ${title} | ${t.status} |\n`;
}

const passed = tests.filter(t => t.status === 'passed').length;
const failed = tests.filter(t => t.status === 'failed').length;
const skipped = tests.filter(t => t.status === 'skipped').length;

body += `\n**Summary:** ${passed} passed, ${failed} failed, ${skipped} skipped.\n`;

fs.writeFileSync(outPath, body);
console.log(`Wrote ${outPath}`);
