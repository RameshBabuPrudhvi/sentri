/**
 * stepSanitiser.js — Converts Playwright code lines to human-readable steps
 *
 * Smaller LLMs (e.g. Mistral 7B) sometimes put Playwright code into the
 * "steps" array instead of plain-English descriptions.  This module detects
 * that and converts them.
 *
 * Exports:
 *   sanitiseSteps(tests) — mutates tests in-place, returns the array
 *   extractTestsArray(parsed) — normalises AI response shapes → array
 */

// ── Code detection ───────────────────────────────────────────────────────────

const CODE_PATTERNS = [
  /^\s*await\s+/,
  /^\s*page\./,
  /^\s*expect\s*\(/,
  /^\s*const\s+/,
  /^\s*let\s+/,
  /^\s*import\s+/,
  /^\s*test\s*\(/,
  /^\s*\/\//,
  /^\s*}\s*\)\s*;?\s*$/,
];

function looksLikeCode(step) {
  if (!step || typeof step !== "string") return false;
  return CODE_PATTERNS.some(re => re.test(step));
}

// ── Label extraction (for human-readable step conversion) ────────────────────

function extractLabel(code) {
  // getByRole('button', { name: 'Submit' })
  const roleMatch = code.match(/getByRole\s*\(\s*['"`][^'"`]*['"`]\s*,\s*\{[^}]*name\s*:\s*['"`]([^'"`]+)['"`]/);
  if (roleMatch) return roleMatch[1];
  // getByText('...')
  const textMatch = code.match(/getByText\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (textMatch) return textMatch[1];
  // getByLabel('...')
  const labelMatch = code.match(/getByLabel\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (labelMatch) return labelMatch[1];
  // getByPlaceholder('...')
  const phMatch = code.match(/getByPlaceholder\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (phMatch) return phMatch[1];
  return null;
}

// ── Code → human step conversion ─────────────────────────────────────────────

/**
 * Convert a Playwright code line into a human-readable step description.
 * e.g. "await page.goto('https://example.com')" → "Navigate to https://example.com"
 */
function codeToHumanStep(code) {
  const s = code.trim();

  // page.goto
  const gotoMatch = s.match(/page\.goto\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (gotoMatch) return `Navigate to ${gotoMatch[1]}`;

  // page.click / page.getByRole(...).click
  const clickMatch = s.match(/\.click\s*\(/);
  if (clickMatch) {
    const label = extractLabel(s);
    return label ? `Click "${label}"` : "Click element";
  }

  // page.fill / .fill
  const fillMatch = s.match(/\.fill\s*\(\s*['"`]?([^'"`),]*)['"`]?\s*,\s*['"`]([^'"`]*)['"`]/);
  if (fillMatch) return `Enter "${fillMatch[2]}" into ${fillMatch[1] || "field"}`;

  // expect(...).toBeVisible
  if (/toBeVisible/.test(s)) {
    const label = extractLabel(s);
    return label ? `Verify "${label}" is visible` : "Verify element is visible";
  }

  // expect(...).toHaveURL
  const urlMatch = s.match(/toHaveURL\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (urlMatch) return `Verify URL is ${urlMatch[1]}`;

  // expect(...).toContainText
  const textMatch = s.match(/toContainText\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (textMatch) return `Verify text "${textMatch[1]}" is present`;

  // page.waitForLoadState
  if (/waitForLoadState/.test(s)) return "Wait for page to load";

  // Generic fallback — strip await/page prefix and camelCase → words
  const stripped = s.replace(/^await\s+/, "").replace(/^page\./, "");
  const words = stripped.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[()'"`;{}]/g, "").trim();
  return words.length > 80 ? words.slice(0, 77) + "…" : words || "Perform action";
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * extractTestsArray(parsed) — normalise the 3 common AI response shapes into
 * a plain array of test objects:
 *   1. Already an array       → return as-is
 *   2. { tests: [...] }       → unwrap
 *   3. Single object { name } → wrap in array
 *   4. Anything else           → empty array
 */
export function extractTestsArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.tests)) return parsed.tests;
  if (parsed && parsed.name) return [parsed];
  return [];
}

/**
 * sanitiseSteps(tests)
 * If a test's steps array contains Playwright code instead of human-readable
 * descriptions (common with smaller LLMs like Mistral 7B), convert them.
 */
export function sanitiseSteps(tests) {
  for (const t of tests) {
    if (!Array.isArray(t.steps) || t.steps.length === 0) continue;
    const codeCount = t.steps.filter(looksLikeCode).length;
    // If more than half the steps look like code, convert all of them
    if (codeCount > t.steps.length / 2) {
      t.steps = t.steps
        .filter(s => s && typeof s === "string" && s.trim())
        .filter(s => !/^\s*}\s*\)\s*;?\s*$/.test(s))           // drop closing braces
        .filter(s => !/^\s*import\s+/.test(s))                  // drop import lines
        .filter(s => !/^\s*test\s*\(/.test(s))                  // drop test(...) wrappers
        .map(s => looksLikeCode(s) ? codeToHumanStep(s) : s);
    }
  }
  return tests;
}
