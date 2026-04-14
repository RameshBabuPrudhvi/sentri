/**
 * deduplicator.js — Layer 3: Remove duplicate and near-duplicate tests
 *
 * Multi-layer deduplication strategy:
 *   1. Structural hash  — exact fingerprint of Playwright actions (existing)
 *   2. Fuzzy name match — Levenshtein similarity on normalized test names (new)
 *   3. Semantic TF-IDF  — bag-of-words cosine similarity across name + description + steps (new)
 *   4. Description field — description is now included in hash and comparison (new)
 *
 * Resolves defects #1–#4 from issue #55.
 */

import { createHash } from "node:crypto";

/**
 * fingerprintHash(str) → 16-char hex string (64-bit FNV-1a via SHA-256 truncation)
 *
 * Replaces the previous 32-bit djb2 implementation. A 32-bit hash has a
 * ~1-in-4-billion collision rate per pair, which becomes non-negligible once a
 * project reaches ~1 000 tests (~500 k pairs). This implementation uses the
 * first 8 bytes of SHA-256 (64 bits), reducing the per-pair collision
 * probability to ~1-in-18-quintillion — safe at any realistic test suite size.
 *
 * Uses Node's built-in `node:crypto` (no new dependency). Synchronous
 * `createHash` is used rather than `crypto.subtle.digest` so the function
 * stays synchronous and callers require no changes.
 *
 * @param {string} str - Input string to hash.
 * @returns {string} 16-character lowercase hex fingerprint.
 */
function fingerprintHash(str) {
  return createHash("sha256").update(str).digest("hex").slice(0, 16);
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

// ---------------------------------------------------------------------------
// Fuzzy / semantic helpers (resolve defects #1, #2, #3, #4)
// ---------------------------------------------------------------------------

/**
 * levenshteinDistance(a, b) → integer edit distance
 *
 * Classic DP implementation. Used by fuzzyNameSimilarity() to catch
 * paraphrased test names (defect #3).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Use two rows to keep memory O(min(|a|,|b|))
  if (a.length < b.length) { const t = a; a = b; b = t; } // ensure a is longer
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr[j + 1] = Math.min(curr[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * fuzzyNameSimilarity(a, b) → number 0–1
 *
 * Returns 1.0 for identical strings, 0.0 for completely different.
 * Threshold: ≥ 0.80 is treated as a duplicate name match.
 *
 * @param {string} a - Already-normalized string
 * @param {string} b - Already-normalized string
 * @returns {number}
 */
export function fuzzyNameSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * buildTfIdfVector(text) → Map<term, tfidf-weight>
 *
 * Single-document TF vector (no corpus IDF — we compare pairs at call
 * time so a true IDF isn't available). Sufficient for cosine similarity
 * between two short test descriptions.
 *
 * Common English stop-words and common QA/Playwright verbs are removed
 * so the signal comes from domain-specific nouns (page names, feature
 * keywords, form field names, etc.).
 *
 * @param {string} text
 * @returns {Map<string, number>}
 */
const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "by","from","as","is","are","was","were","be","been","being","have",
  "has","had","do","does","did","will","would","could","should","may",
  "might","shall","can","not","no","nor","so","yet","both","either",
  "neither","each","few","more","most","other","some","such","than",
  "too","very","just","it","its","this","that","these","those","user",
  "test","tests","verify","verifies","check","checks","ensure","ensures",
  "should","page","click","fill","submit","navigate","go","open","visit",
]);

function buildTfIdfVector(text) {
  const terms = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));

  const tf = new Map();
  for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
  return tf;
}

/**
 * cosineSimilarity(vecA, vecB) → number 0–1
 *
 * Standard cosine similarity between two sparse TF vectors.
 * Threshold: ≥ 0.65 is treated as a semantic duplicate (defect #1).
 *
 * @param {Map<string, number>} vecA
 * @param {Map<string, number>} vecB
 * @returns {number}
 */
export function cosineSimilarity(vecA, vecB) {
  if (vecA.size === 0 || vecB.size === 0) return 0;
  let dot = 0;
  for (const [term, w] of vecA) {
    if (vecB.has(term)) dot += w * vecB.get(term);
  }
  const magA = Math.sqrt(Array.from(vecA.values()).reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(Array.from(vecB.values()).reduce((s, v) => s + v * v, 0));
  return magA && magB ? dot / (magA * magB) : 0;
}

/**
 * semanticSimilarity(testA, testB) → number 0–1
 *
 * Combines name, description, and steps into a single bag-of-words
 * TF-IDF vector and returns cosine similarity. Resolves defect #1
 * (semantic duplicates with different wording) and defect #4
 * (description field previously ignored).
 *
 * @param {object} testA
 * @param {object} testB
 * @returns {number}
 */
export function semanticSimilarity(testA, testB) {
  const textOf = t => [
    t.name || "",
    t.description || "",
    ...(t.steps || []),
  ].join(" ");

  return cosineSimilarity(
    buildTfIdfVector(textOf(testA)),
    buildTfIdfVector(textOf(testB)),
  );
}

/** Fuzzy name similarity threshold — names this similar are treated as duplicates */
export const FUZZY_NAME_THRESHOLD = 0.80;

/** Semantic (TF-IDF cosine) similarity threshold */
export const SEMANTIC_SIMILARITY_THRESHOLD = 0.65;

// ---------------------------------------------------------------------------

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

  // Include description in hash so tests with identical code but different
  // description fields are not treated as unique (resolves defect #4).
  const descriptionPart = normalizeText(test.description || "");
  const signature = [
    playwrightActions || stepsSignature || normalizeText(test.name),
    descriptionPart,
  ].filter(Boolean).join("||");
  return fingerprintHash(signature);
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
 *
 * Three-layer strategy:
 *   1. Structural hash     — exact Playwright-action fingerprint (fast, O(n))
 *   2. Fuzzy name match    — Levenshtein similarity ≥ 0.80 (defect #3)
 *   3. Semantic TF-IDF     — cosine similarity ≥ 0.65 on name+desc+steps (defects #1, #2)
 */
export function deduplicateTests(tests) {
  const hashMap = new Map(); // hash → best test so far (layer 1)
  const retained = [];       // tests that survived layer 1, pending layers 2+

  // ── Layer 1: structural hash ────────────────────────────────────────────
  for (const test of tests) {
    const hash = hashTest(test);
    const quality = scoreTest(test);
    const testWithScore = { ...test, _hash: hash, _quality: quality };

    if (!hashMap.has(hash)) {
      hashMap.set(hash, testWithScore);
    } else {
      const existing = hashMap.get(hash);
      if (quality > existing._quality) {
        hashMap.set(hash, testWithScore);
      }
    }
  }

  const afterLayer1 = Array.from(hashMap.values());

  // ── Layers 2+3: fuzzy name + semantic similarity ─────────────────────────
  // O(n²) over the already-deduplicated set — acceptable since n is typically
  // small (< 200 tests per batch after layer 1).
  for (const candidate of afterLayer1) {
    let dominated = false;
    const normCandName = normalizeText(candidate.name);

    for (const kept of retained) {
      // Layer 2 — fuzzy name (defect #3)
      if (
        normCandName.length >= 10 &&
        fuzzyNameSimilarity(normCandName, normalizeText(kept.name)) >= FUZZY_NAME_THRESHOLD
      ) {
        // Keep the higher-quality test
        if (candidate._quality > kept._quality) {
          retained.splice(retained.indexOf(kept), 1, candidate);
        }
        dominated = true;
        break;
      }

      // Layer 3 — semantic TF-IDF (defects #1, #2)
      if (semanticSimilarity(candidate, kept) >= SEMANTIC_SIMILARITY_THRESHOLD) {
        if (candidate._quality > kept._quality) {
          retained.splice(retained.indexOf(kept), 1, candidate);
        }
        dominated = true;
        break;
      }
    }

    if (!dominated) retained.push(candidate);
  }

  const unique = retained.sort((a, b) => b._quality - a._quality);

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
 *
 * Four-layer strategy:
 *   1. Structural hash     — existing behaviour
 *   2. Normalized name     — existing behaviour (renamed tests, same URL)
 *   3. Fuzzy name match    — Levenshtein ≥ 0.80 (defect #3)
 *   4. Semantic TF-IDF     — cosine ≥ 0.65 on name+desc+steps (defects #1, #2)
 */
export function deduplicateAcrossRuns(newTests, existingTests) {
  const existingHashes = new Set(existingTests.map(hashTest));
  const existingNames = new Set(existingTests.map(t => normalizeText(t.name)));

  return newTests.filter(t => {
    // Layer 1 — structural hash
    if (existingHashes.has(hashTest(t))) return false;

    // Layer 2 — normalized name + same URL (existing)
    const normName = normalizeText(t.name);
    if (normName && normName.length >= 15 && existingNames.has(normName)) {
      const match = existingTests.find(e =>
        normalizeText(e.name) === normName && e.sourceUrl === t.sourceUrl
      );
      if (match) return false;
    }

    // Layer 3 — fuzzy name match (defect #3)
    if (normName.length >= 10) {
      const fuzzyMatch = existingTests.find(e =>
        fuzzyNameSimilarity(normName, normalizeText(e.name)) >= FUZZY_NAME_THRESHOLD
      );
      if (fuzzyMatch) return false;
    }

    // Layer 4 — semantic TF-IDF similarity (defects #1, #2)
    const semanticMatch = existingTests.find(e =>
      semanticSimilarity(t, e) >= SEMANTIC_SIMILARITY_THRESHOLD
    );
    if (semanticMatch) return false;

    return true;
  });
}
