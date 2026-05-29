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
import { formatLogLine } from "../utils/logFormatter.js";

/**
 * fingerprintHash(str) → 16-char hex string (64-bit via SHA-256 truncation)
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
  if (vecA === vecB) return 1;
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

/**
 * Bundle-A fix #11 — scenario guard for fuzzy / semantic dedup.
 *
 * Two tests with similar names on the same URL are treated as the same
 * scenario when:
 *   - both omit `scenario` (legacy path — falls back to pre-fix behaviour
 *     so existing duplicates still dedupe), OR
 *   - either side omits `scenario` (one of the two is legacy / partial), OR
 *   - both have the same `scenario` value (e.g. both `"positive"`).
 *
 * Different non-null scenarios (`"positive"` vs `"negative"`) are treated
 * as different and must NOT be deduplicated even when the names + URL
 * match — "Login with valid credentials" and "Login with invalid
 * credentials" are the intended positive / negative coverage of the same
 * flow and both must survive.
 *
 * Exported as a named helper so both `deduplicateTests` (within-batch)
 * and `deduplicateAcrossRuns` (cross-run) share one implementation and
 * the semantics can't drift between the two layers.
 */
export function sameDedupScenario(a, b) {
  return a == null || b == null || a === b;
}

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
  // descriptions produce distinct fingerprints (resolves defect #4).
  const descriptionPart = normalizeText(test.description || "");
  const signature = [
    playwrightActions || stepsSignature || normalizeText(test.name),
    descriptionPart,
  ].filter(Boolean).join("||");
  return fingerprintHash(signature);
}

// Quality-score rubric — single source of truth for both the numeric score
// and the per-factor breakdown surfaced in the Review Queue's "why was this
// drafted?" explainer.
//
// Each factor has a stable `id` (keyed by the frontend so display copy can
// evolve without breaking historical data), a short human-readable `label`,
// the `delta` it contributes when the `hit(test, code)` predicate returns
// true, and a `kind` so consumers can render rewards (✓) and penalties (✗)
// differently. **Append-only:** never edit IDs in place — they're persisted
// per-test in the `qualityScoreFactors` JSON column and shipped over the API.
const HIGH_VALUE_TYPES = new Set([
  // Legacy intent-based types (from crawl pipeline)
  "form", "form_submission", "auth", "checkout", "crud", "search",
  // Industry-standard types (from new prompt templates)
  "functional", "smoke", "regression", "e2e", "integration",
  "accessibility", "security", "performance",
]);

const QUALITY_FACTORS = [
  // ── Strong assertions ──
  { id: "assert.url",        label: "URL assertion",          delta:  20, kind: "reward",  hit: (_, c) => c.includes("toHaveURL") },
  { id: "assert.title",      label: "Title assertion",        delta:  15, kind: "reward",  hit: (_, c) => c.includes("toHaveTitle") },
  { id: "assert.visible",    label: "Visibility assertion",   delta:  15, kind: "reward",  hit: (_, c) => c.includes("toBeVisible") },
  { id: "assert.text",       label: "Text assertion",         delta:  15, kind: "reward",  hit: (_, c) => c.includes("toHaveText") || c.includes("toContainText") },
  { id: "assert.enabled",    label: "Enabled-state check",    delta:  10, kind: "reward",  hit: (_, c) => c.includes("toBeEnabled") },
  { id: "assert.value",      label: "Value assertion",        delta:  10, kind: "reward",  hit: (_, c) => c.includes("toHaveValue") },
  { id: "assert.multiple",   label: "Multiple assertions",    delta:  20, kind: "reward",  hit: (_, c) => (c.match(/expect\(/g) || []).length >= 2 },
  // ── Weak / missing assertions ──
  { id: "assert.weak",       label: "Weak assertions",        delta: -20, kind: "penalty", hit: (_, c) => c.includes("toBeTruthy") || c.includes("toBeDefined") },
  { id: "assert.none",       label: "No assertions",          delta: -30, kind: "penalty", hit: (_, c) => !c.includes("expect(") },
  // ── Test metadata ──
  { id: "name.descriptive",  label: "Descriptive name",       delta:   5, kind: "reward",  hit: (t)    => !!t.name && t.name.length > 10 },
  { id: "priority.high",     label: "High priority",          delta:  10, kind: "reward",  hit: (t)    => t.priority === "high" },
  { id: "priority.medium",   label: "Medium priority",        delta:   5, kind: "reward",  hit: (t)    => t.priority === "medium" },
  { id: "type.high-value",   label: "High-value test type",   delta:  15, kind: "reward",  hit: (t)    => HIGH_VALUE_TYPES.has((t.type || "").toLowerCase()) },
  // ── Selectors ──
  { id: "selector.semantic", label: "Semantic selectors",     delta:  10, kind: "reward",  hit: (_, c) => c.includes("getByRole") || c.includes("getByLabel") || c.includes("getByText") },
  { id: "selector.testid",   label: "Test-ID selectors",      delta:  10, kind: "reward",  hit: (_, c) => c.includes("data-testid") || c.includes("test-id") },
  { id: "selector.fragile",  label: "Fragile nth selectors",  delta: -10, kind: "penalty", hit: (_, c) => (c.match(/\.nth\(|nth-child|nth-of-type/g) || []).length > 2 },
];

/**
 * scoreTestWithFactors(test) → { score: number, factors: Array<{ id, label, delta, kind }> }
 *
 * Companion to {@link scoreTest} that *also* returns the list of factors that
 * applied. Drives the Review Queue's "why was this drafted?" explainer so a
 * reviewer can see at a glance which rewards and penalties produced the score
 * — without inspecting the test code.
 *
 * The numeric score is identical to `scoreTest()`'s output; the two functions
 * share the {@link QUALITY_FACTORS} rubric so they can never drift.
 *
 * @param {object} test
 * @returns {{ score: number, factors: Array<{ id: string, label: string, delta: number, kind: "reward"|"penalty" }> }}
 */
export function scoreTestWithFactors(test) {
  const code = test.playwrightCode || "";
  const factors = [];
  let raw = 0;
  for (const f of QUALITY_FACTORS) {
    if (f.hit(test, code)) {
      factors.push({ id: f.id, label: f.label, delta: f.delta, kind: f.kind });
      raw += f.delta;
    }
  }
  return { score: Math.max(0, Math.min(100, raw)), factors };
}

/**
 * normalizeQualityToConfidence(quality) → number 0–1
 *
 * Single source of truth for converting the 0–100 quality rubric output
 * (`scoreTest` / `_quality`) into the 0–1 `confidenceScore` scale used by
 * AUTO-003b's `autoApproveThreshold` comparison. Previously this `/100`
 * normalization was inlined in three places (`deduplicator.js`,
 * `pipelineOrchestrator.js`, `testPersistence.js`); centralizing avoids
 * drift if the rubric range ever changes.
 *
 * Coerces non-finite / negative inputs to 0 and clamps to [0, 1] so callers
 * can safely use the result without revalidating.
 *
 * @param {number} quality — 0–100 score from scoreTest / scoreTestWithFactors
 * @returns {number} 0–1 confidence
 */
export function normalizeQualityToConfidence(quality) {
  const q = Number.isFinite(quality) ? quality : 0;
  if (q <= 0) return 0;
  if (q >= 100) return 1;
  return q / 100;
}

/**
 * scoreTest(test) → number 0–100
 *
 * Quality score used to pick the best test when duplicates are found.
 * Higher = better quality test to keep.
 *
 * Thin wrapper around {@link scoreTestWithFactors} — kept as a separate
 * export so existing call sites (`deduplicateTests`, `testPersistence`) and
 * unit tests don't need to know about the factor breakdown.
 */
export function scoreTest(test) {
  return scoreTestWithFactors(test).score;
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
  if (tests.length > 200) {
    console.warn(formatLogLine("warn", null,
      `[deduplicator] Large batch (${tests.length} tests) — O(n²) dedup stages may be slow`));
  }

  const hashMap = new Map(); // hash → best test so far (layer 1)
  const retained = [];       // tests that survived layer 1, pending layers 2+

  // ── Layer 1: structural hash ────────────────────────────────────────────
  for (const test of tests) {
    const hash = hashTest(test);
    const { score: quality, factors } = scoreTestWithFactors(test);
    const testWithScore = {
      ...test,
      _hash: hash,
      _quality: quality,
      _qualityFactors: factors,
      // `quality` is on a 0–100 scale (see scoreTestWithFactors); the
      // `autoApproveThreshold` config is on a 0–1 scale per AUTO-003b.
      // Normalize here so a single comparison in testPersistence.js works.
      confidenceScore: normalizeQualityToConfidence(quality),
    };

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
      // Guard with sourceUrl (consistent with deduplicateAcrossRuns Layer 3)
      // so tests targeting different pages with similar names are not falsely
      // deduplicated within the same batch.
      if (
        normCandName.length >= 15 &&
        candidate.sourceUrl && candidate.sourceUrl === kept.sourceUrl &&
        sameDedupScenario(candidate.scenario, kept.scenario) &&
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
      // Guard with name length (consistent with deduplicateAcrossRuns Layer 4)
      // — short names produce tiny TF-IDF vectors where a single shared term
      // yields cosine ≈ 1.0, causing false positives.
      // Guard with sourceUrl so tests on different pages that share vocabulary
      // are not falsely deduplicated.
      // Bundle-A fix #11 — scenario guard (see `sameDedupScenario` docblock).
      if (
        normCandName.length >= 15 &&
        candidate.sourceUrl && candidate.sourceUrl === kept.sourceUrl &&
        sameDedupScenario(candidate.scenario, kept.scenario) &&
        semanticSimilarity(candidate, kept) >= SEMANTIC_SIMILARITY_THRESHOLD
      ) {
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
  const crossProduct = existingTests.length * newTests.length;
  if (crossProduct > 40_000) {
    console.warn(formatLogLine("warn", null,
      `[deduplicator] Large cross-run dedup (${newTests.length} new × ${existingTests.length} existing = ${crossProduct} comparisons) — O(n²) stages may be slow`));
  }

  const existingHashes = new Set(existingTests.map(hashTest));
  const existingNames = new Set(existingTests.map(t => normalizeText(t.name)));

  return newTests.filter(t => {
    // Layer 1 — structural hash
    if (existingHashes.has(hashTest(t))) return false;

    // Layer 2 — normalized name + same URL (existing)
    const normName = normalizeText(t.name);
    if (normName && normName.length >= 15 && existingNames.has(normName)) {
      const match = existingTests.find(e =>
        normalizeText(e.name) === normName && t.sourceUrl && e.sourceUrl === t.sourceUrl
      );
      if (match) return false;
    }

    // Layer 3 — fuzzy name match (defect #3)
    // Guard with sourceUrl (consistent with Layer 2) so tests targeting
    // different pages with similar names are not falsely deduplicated.
    // Bundle-A fix #11 — scenario guard so positive/negative coverage of
    // the same flow on the same URL is never collapsed (see
    // `sameDedupScenario` docblock).
    if (normName.length >= 15) {
      const fuzzyMatch = existingTests.find(e =>
        t.sourceUrl && e.sourceUrl === t.sourceUrl &&
        sameDedupScenario(t.scenario, e.scenario) &&
        fuzzyNameSimilarity(normName, normalizeText(e.name)) >= FUZZY_NAME_THRESHOLD
      );
      if (fuzzyMatch) return false;
    }

    // Layer 4 — semantic TF-IDF similarity (defects #1, #2)
    // Guard with sourceUrl so tests on different pages that share vocabulary
    // (e.g. "form validation" on login vs signup) are not falsely deduplicated.
    // Also require the normalized name to be long enough (≥ 15 chars, consistent
    // with Layers 2 and 3) — short names produce tiny TF-IDF vectors where a
    // single shared term yields cosine ≈ 1.0, causing false positives.
    // Bundle-A fix #11 — scenario guard (see `sameDedupScenario`).
    if (normName.length >= 15) {
      const semanticMatch = existingTests.find(e =>
        t.sourceUrl && e.sourceUrl === t.sourceUrl &&
        sameDedupScenario(t.scenario, e.scenario) &&
        semanticSimilarity(t, e) >= SEMANTIC_SIMILARITY_THRESHOLD
      );
      if (semanticMatch) return false;
    }

    return true;
  });
}
