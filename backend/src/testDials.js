/**
 * testDials.js — Server-side Test Dials: validation + prompt builder
 *
 * The frontend sends a structured config object (strategy, workflow[], quality[],
 * format, language, automationHooks, customModifier).  This module validates it
 * against known option IDs and builds the prompt fragment that gets injected into
 * AI calls.  Keeping this logic server-side means:
 *
 *   1. The backend controls what text reaches the AI — no prompt injection risk.
 *   2. The same builder can be reused by backend-only flows (scheduled runs, API).
 *   3. Unknown / malicious option IDs are silently dropped.
 *   4. customModifier is length-capped and stripped of prompt-injection markers.
 */

// ─── Canonical option definitions (single source of truth) ─────────────────

export const STRATEGY_OPTIONS = [
  { id: "happy_path",    label: "Happy Path Only" },
  { id: "sad_path",      label: "Sad Path & Error Handling" },
  { id: "edge_cases",    label: "Boundary & Edge Cases" },
  { id: "comprehensive", label: "Comprehensive 360 Suite" },
  { id: "exploratory",   label: "Exploratory Charter" },
  { id: "regression",    label: "Regression Impact Analysis" },
];

export const WORKFLOW_OPTIONS = [
  { id: "e2e",             label: "End-to-End User Journey" },
  { id: "component",       label: "Component-Level Isolation" },
  { id: "multi_role",      label: "Multi-Role Persona" },
  { id: "first_time_user", label: "First-Time User Experience" },
  { id: "interruptions",   label: "Interruptions" },
];

export const QUALITY_OPTIONS = [
  { id: "accessibility",   label: "Accessibility (a11y)" },
  { id: "performance",     label: "Performance" },
  { id: "security",        label: "Security" },
  { id: "data_integrity",  label: "Data Integrity" },
  { id: "api_integration", label: "API & Integration" },
  { id: "localization",    label: "Localization (L10n)" },
  { id: "reliability",     label: "Reliability" },
  { id: "observability",   label: "Observability" },
];

export const FORMAT_OPTIONS = [
  { id: "verbose", label: "Verbose Steps" },
  { id: "concise", label: "Concise Checklist" },
  { id: "gherkin", label: "Gherkin (Given/When/Then)" },
];

export const LANGUAGES = [
  { code: "en-US", label: "English (Default)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "es",    label: "Spanish" },
  { code: "fr",    label: "French" },
  { code: "de",    label: "German" },
  { code: "ja",    label: "Japanese" },
  { code: "zh",    label: "Chinese" },
  { code: "pt",    label: "Portuguese" },
];

export const TEST_COUNT_OPTIONS = [
  { id: "single",        label: "Single Test (1)" },
  { id: "few",           label: "Few (3–5)" },
  { id: "moderate",      label: "Moderate (6–10)" },
  { id: "comprehensive", label: "Many (10–20)" },
  { id: "auto",          label: "Auto (AI decides)" },
];

// Quick lookup sets for validation
const VALID_STRATEGIES = new Set(STRATEGY_OPTIONS.map(s => s.id));
const VALID_WORKFLOWS  = new Set(WORKFLOW_OPTIONS.map(w => w.id));
const VALID_QUALITIES  = new Set(QUALITY_OPTIONS.map(q => q.id));
const VALID_FORMATS    = new Set(FORMAT_OPTIONS.map(f => f.id));
const VALID_LANGUAGES   = new Set(LANGUAGES.map(l => l.code));
const VALID_TEST_COUNTS = new Set(TEST_COUNT_OPTIONS.map(t => t.id));

const CUSTOM_MODIFIER_MAX_LENGTH = 500;

// ─── Validate & sanitise a dials config from the client ────────────────────

/**
 * validateDialsConfig(raw) → sanitised config object (or null if input is empty)
 *
 * - Drops unknown option IDs silently (no error — just ignored).
 * - Caps customModifier at 500 chars.
 * - Returns null when the input is falsy or not an object.
 */
export function validateDialsConfig(raw) {
  if (!raw || typeof raw !== "object") return null;

  const strategy = VALID_STRATEGIES.has(raw.strategy) ? raw.strategy : null;

  const workflow = Array.isArray(raw.workflow)
    ? raw.workflow.filter(id => VALID_WORKFLOWS.has(id))
    : [];

  const quality = Array.isArray(raw.quality)
    ? raw.quality.filter(id => VALID_QUALITIES.has(id))
    : [];

  const format = VALID_FORMATS.has(raw.format) ? raw.format : null;

  const language = VALID_LANGUAGES.has(raw.language) ? raw.language : "en-US";

  const testCount = VALID_TEST_COUNTS.has(raw.testCount) ? raw.testCount : "auto";

  const automationHooks = raw.automationHooks === true;

  // Sanitise free-text: trim, cap length, strip anything that looks like a
  // prompt-injection boundary (e.g. "SYSTEM:", "ASSISTANT:", triple backticks).
  let customModifier = typeof raw.customModifier === "string"
    ? raw.customModifier.trim().slice(0, CUSTOM_MODIFIER_MAX_LENGTH)
    : "";
  // Remove common prompt-injection markers
  customModifier = customModifier
    .replace(/^(SYSTEM|ASSISTANT|USER|HUMAN|AI)\s*:/gim, "")
    .replace(/```/g, "")
    .trim();

  return { strategy, workflow, quality, format, language, testCount, automationHooks, customModifier };
}

// ─── Build the prompt fragment from a validated config ──────────────────────

/**
 * buildDialsPrompt(cfg) → string
 *
 * Accepts a config object (ideally from validateDialsConfig) and returns a
 * prompt fragment ready to be inserted into an AI prompt.  Returns "" when
 * the config is null or has no active dials.
 */
export function buildDialsPrompt(cfg) {
  if (!cfg) return "";

  const strategy   = STRATEGY_OPTIONS.find(s => s.id === cfg.strategy);
  const format     = FORMAT_OPTIONS.find(f => f.id === cfg.format);
  const testCount  = TEST_COUNT_OPTIONS.find(t => t.id === cfg.testCount);
  const workflows  = WORKFLOW_OPTIONS.filter(w => cfg.workflow.includes(w.id));
  const qualities  = QUALITY_OPTIONS.filter(q => cfg.quality.includes(q.id));

  const lines = [
    "TEST GENERATION CONFIGURATION:",
    strategy          ? `- Strategy: ${strategy.label}`                                                    : "",
    testCount && cfg.testCount !== "auto"
                      ? `- Number of tests: ${testCount.label} — generate exactly this many test cases`    : "",
    workflows.length  ? `- Perspectives: ${workflows.map(w => w.label).join(", ")}`                        : "",
    qualities.length  ? `- Quality checks: ${qualities.map(q => q.label).join(", ")}`                      : "",
    format            ? `- Output format: ${format.label}`                                                 : "",
    cfg.language !== "en-US" ? `- Output language: ${LANGUAGES.find(l => l.code === cfg.language)?.label}` : "",
    cfg.automationHooks      ? "- Include automation element ID hooks (data-testid attributes)"             : "",
    cfg.customModifier       ? `- Additional requirements: ${cfg.customModifier}`                           : "",
  ].filter(Boolean);

  // If only the header line survived, there's nothing meaningful to inject
  return lines.length > 1 ? lines.join("\n") : "";
}

// ─── Convenience: validate + build in one call ─────────────────────────────

/**
 * resolveDialsPrompt(rawConfigOrString) → string
 *
 * Accepts either:
 *   - A structured dials config object (new approach) → validate + build
 *   - A pre-built prompt string (legacy / backwards compat) → ""
 *     (We intentionally discard raw strings to prevent prompt injection.)
 *
 * This is the single entry-point that route handlers should use.
 */
export function resolveDialsPrompt(input) {
  // Reject raw strings — only structured configs are accepted
  if (typeof input === "string") return "";
  const cfg = validateDialsConfig(input);
  return buildDialsPrompt(cfg);
}
