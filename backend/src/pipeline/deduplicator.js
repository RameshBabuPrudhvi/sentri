/**
 * deduplicator.js — Layer 3: Remove duplicate and near-duplicate tests
 *
 * Uses structural hashing of test steps and playwright code fingerprints.
 */

/**
 * Simple deterministic hash — no crypto dependency needed
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit int
  }
  return Math.abs(hash).toString(36);
}

/**
 * normalizeText(s) → lowercase, whitespace-collapsed string
 * Used so minor phrasing differences don't create false uniqueness
 */
function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * hashTest(test) → string fingerprint
 *
 * Generates a fingerprint from the test's structural content,
 * ignoring surface-level wording differences.
 */
export function hashTest(test) {
  // Extract the key actions from playwright code (goto, click, fill, expect)
  const playwrightActions = (test.playwrightCode || "")
    .split("\n")
    .filter(line => /await\s+(page\.|expect\()/.test(line))
    .map(line => normalizeText(line))
    .join("|");

  // Fallback: hash from steps
  const stepsSignature = (test.steps || [])
    .map(s => normalizeText(s))
    .join("|");

  const signature = playwrightActions || stepsSignature || normalizeText(test.name);
  return simpleHash(signature);
}

/**
 * scoreTest(test) → number 0–100
 *
 * Quality score used to pick the best test when duplicates are found.
 * Higher = better quality test to keep.
 */
export function scoreTest(test) {
  let score = 0;
  const code = test.playwrightCode || "";
  const steps = (test.steps || []).join(" ");

  // Reward strong assertions
  if (code.includes("toHaveURL")) score += 20;
  if (code.includes("toHaveTitle")) score += 15;
  if (code.includes("toBeVisible")) score += 15;
  if (code.includes("toHaveText") || code.includes("toContainText")) score += 15;
  if (code.includes("toBeEnabled")) score += 10;
  if (code.includes("toHaveValue")) score += 10;
  if ((code.match(/expect\(/g) || []).length >= 2) score += 20; // multiple assertions

  // Penalize weak assertions
  if (code.includes("toBeTruthy") || code.includes("toBeDefined")) score -= 20;
  if (!(code.includes("expect("))) score -= 30; // no assertions at all

  // Reward meaningful test names
  if (test.name && test.name.length > 10) score += 5;

  // Reward high priority
  if (test.priority === "high") score += 10;
  if (test.priority === "medium") score += 5;

  // Reward by test type — covers both legacy intent-based types (auth, checkout,
  // form_submission) and new industry-standard types (functional, e2e, smoke, etc.)
  // Uses a Set with exact match to avoid false positives from substring matching
  // (e.g. "form" matching "performance").
  const HIGH_VALUE_TYPES = new Set([
    // Legacy intent-based types (from crawl pipeline)
    "form", "form_submission", "auth", "checkout", "crud", "search",
    // Industry-standard types (from new prompt templates)
    "functional", "smoke", "regression", "e2e", "integration",
    "accessibility", "security", "performance",
  ]);
  if (HIGH_VALUE_TYPES.has((test.type || "").toLowerCase())) score += 15;

  // Reward stable selectors
  if (code.includes("getByRole") || code.includes("getByLabel") || code.includes("getByText")) score += 10;
  if (code.includes("data-testid") || code.includes("test-id")) score += 10;

  // Penalize fragile selectors
  if ((code.match(/\.nth\(|nth-child|nth-of-type/g) || []).length > 2) score -= 10;

  return Math.max(0, Math.min(100, score));
}

/**
 * deduplicateTests(tests) → { unique: Array, removed: number, stats: object }
 *
 * Main deduplication function. Returns only the best unique tests.
 */
export function deduplicateTests(tests) {
  const hashMap = new Map(); // hash → best test so far

  for (const test of tests) {
    const hash = hashTest(test);
    const quality = scoreTest(test);
    const testWithScore = { ...test, _hash: hash, _quality: quality };

    if (!hashMap.has(hash)) {
      hashMap.set(hash, testWithScore);
    } else {
      const existing = hashMap.get(hash);
      // Keep the higher quality test
      if (quality > existing._quality) {
        hashMap.set(hash, testWithScore);
      }
    }
  }

  const unique = Array.from(hashMap.values())
    .sort((a, b) => b._quality - a._quality);

  return {
    unique,
    removed: tests.length - unique.length,
    stats: {
      total: tests.length,
      unique: unique.length,
      duplicatesRemoved: tests.length - unique.length,
      averageQuality: unique.length
        ? Math.round(unique.reduce((s, t) => s + t._quality, 0) / unique.length)
        : 0,
    },
  };
}

/**
 * deduplicateAcrossRuns(newTests, existingTests) → filtered new tests
 *
 * Prevents re-adding tests that already exist for the project.
 * Uses both structural hash AND normalised name matching so renamed
 * tests with identical code are still detected as duplicates.
 */
export function deduplicateAcrossRuns(newTests, existingTests) {
  const existingHashes = new Set(existingTests.map(hashTest));
  // Also index by normalised name to catch renamed duplicates —
  // the dashboard flagged that exact name+description matching lets
  // renamed tests slip through as false-unique.
  const existingNames = new Set(existingTests.map(t => normalizeText(t.name)));
  return newTests.filter(t => {
    if (existingHashes.has(hashTest(t))) return false;
    // If the name is identical (after normalisation) AND the test targets
    // the same URL, treat it as a duplicate even if the code differs slightly
    // (e.g. regenerated with different selector strategies).
    const normName = normalizeText(t.name);
    if (normName && existingNames.has(normName)) {
      const match = existingTests.find(e =>
        normalizeText(e.name) === normName && e.sourceUrl === t.sourceUrl
      );
      if (match) return false;
    }
    return true;
  });
}
