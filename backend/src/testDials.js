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
  { id: "happy_path",    label: "Happy Path Only",
    instruction: "Generate ONLY positive/happy-path tests — every test must follow the expected successful user flow from start to finish. Do NOT include error handling, validation failures, or edge cases." },
  { id: "sad_path",      label: "Sad Path & Error Handling",
    instruction: "Focus on NEGATIVE tests — invalid inputs, missing required fields, wrong credentials, expired sessions, permission denials. Every test must trigger an error state and assert that the application displays a clear, user-facing error message or validation indicator." },
  { id: "edge_cases",    label: "Boundary & Edge Cases",
    instruction: "Focus on BOUNDARY and EDGE-CASE tests — empty strings, maximum-length inputs, special characters (unicode, emoji, SQL injection strings), zero-quantity values, rapid repeated clicks, browser back/forward during flows, and race conditions. Each test must push the application to its limits." },
  { id: "comprehensive", label: "Comprehensive 360 Suite",
    instruction: "Generate a BALANCED mix of positive (happy path), negative (error handling), and edge-case tests. Aim for roughly 50% positive, 30% negative, and 20% edge cases. Cover the full spectrum of user interactions on the page." },
  { id: "exploratory",   label: "Exploratory Charter",
    instruction: "Generate EXPLORATORY tests that probe unexpected user behaviours — unusual navigation sequences, interacting with elements in non-obvious order, combining features in ways a typical user would not, and verifying the application recovers gracefully from unexpected states." },
  { id: "regression",    label: "Regression Impact Analysis",
    instruction: "Generate REGRESSION tests that verify existing core functionality still works correctly — focus on the most critical user flows (login, checkout, data submission, navigation) and assert that their expected outcomes have not changed. Prioritise stability assertions (URLs, key text, element visibility) over exploratory coverage." },
];

export const WORKFLOW_OPTIONS = [
  { id: "e2e",             label: "End-to-End User Journey",
    instruction: "Tests must span multiple pages/steps as a complete user flow (e.g. login → dashboard → action → logout). Assert outcomes at each transition point." },
  { id: "component",       label: "Component-Level Isolation",
    instruction: "Tests must focus on a SINGLE component or widget in isolation — test all its interactive states (default, hover, active, disabled, error) without navigating away from the current page." },
  { id: "multi_role",      label: "Multi-Role Persona",
    instruction: "Generate separate tests for DIFFERENT user roles (e.g. admin, regular user, guest/unauthenticated). Each test must assert role-specific behaviour — elements visible to admin but hidden from guest, restricted actions returning permission errors, etc." },
  { id: "first_time_user", label: "First-Time User Experience",
    instruction: "Tests must simulate a BRAND-NEW user who has never seen the application — verify onboarding flows, empty states, tooltip/help text visibility, and that the first interaction path is intuitive and error-free." },
  { id: "interruptions",   label: "Interruptions",
    instruction: "Tests must simulate INTERRUPTED flows — page refresh mid-form, browser back button during checkout, network disconnect/reconnect, session timeout during a multi-step process. Assert the application recovers gracefully or preserves user data." },
];

export const QUALITY_OPTIONS = [
  { id: "accessibility",   label: "Accessibility (a11y)",
    instruction: "Include accessibility assertions: verify ARIA roles/labels are present on interactive elements, check keyboard navigation (Tab order, Enter/Space activation), assert focus indicators are visible, and verify screen-reader-friendly alt text on images. Use getByRole() selectors to confirm semantic HTML." },
  { id: "performance",     label: "Performance",
    instruction: "Add performance-sensitive assertions: verify that key pages load within acceptable timeouts, assert that large lists or images use lazy loading (elements appear on scroll), and check that no critical resource requests return 4xx/5xx status codes in the network log." },
  { id: "security",        label: "Security",
    instruction: "Include security-focused tests: attempt XSS payloads (<script>alert(1)</script>) in input fields and assert they are escaped/rejected, verify that sensitive pages redirect unauthenticated users to login, check that password fields mask input, and assert that CSRF tokens or auth headers are present on form submissions." },
  { id: "data_integrity",  label: "Data Integrity",
    instruction: "Include data integrity assertions: after creating/editing a record, reload the page and assert the data persists correctly. Verify that numeric fields reject non-numeric input, date fields enforce valid ranges, and that duplicate submissions are blocked or handled idempotently." },
  { id: "api_integration", label: "API & Integration",
    instruction: "Include API-level assertions: use page.waitForResponse() to intercept key API calls and assert they return 2xx status codes with expected response shapes. Verify that form submissions trigger the correct backend endpoints and that error responses from the API surface as user-visible messages." },
  { id: "localization",    label: "Localization (L10n)",
    instruction: "Include localisation checks: verify that UI text does not overflow containers (test with longer locale strings if possible), assert that date/number formats match the expected locale, and check that translated strings are present and not showing raw i18n keys like 'common.submit'." },
  { id: "reliability",     label: "Reliability",
    instruction: "Include reliability/resilience tests: retry flaky user actions (e.g. double-click submit), test behaviour after page refresh mid-flow, verify that error recovery paths return the user to a usable state, and assert that concurrent operations (e.g. two tabs) do not corrupt shared state." },
  { id: "observability",   label: "Observability",
    instruction: "Include observability assertions: check the browser console for JavaScript errors (page.on('console') / page.on('pageerror')), verify that no uncaught exceptions are thrown during the test flow, and assert that key analytics or telemetry events fire (if observable via network requests)." },
];

export const FORMAT_OPTIONS = [
  { id: "verbose", label: "Verbose Steps",
    instruction: "Format each test with DETAILED numbered steps — each step must include the exact user action AND the expected result. Example: '1. Click the \"Submit\" button → A success toast appears with text \"Saved successfully\"'." },
  { id: "concise", label: "Concise Checklist",
    instruction: "Format each test as a SHORT bullet-point checklist — one line per action/assertion, no prose. Example: '• Fill email → valid@test.com • Click Submit • Assert: success message visible'." },
  { id: "gherkin", label: "Gherkin (Given/When/Then)",
    instruction: "Format each test's steps using strict Gherkin syntax: 'Given [precondition]', 'When [action]', 'Then [expected outcome]', with 'And' for additional clauses. Each step must start with exactly one of these keywords." },
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
  const workflows  = WORKFLOW_OPTIONS.filter(w => (cfg.workflow || []).includes(w.id));
  const qualities  = QUALITY_OPTIONS.filter(q => (cfg.quality || []).includes(q.id));

  const lines = [
    "TEST GENERATION CONFIGURATION:",
    strategy          ? `- Strategy: ${strategy.instruction}`                                              : "",
    testCount && cfg.testCount !== "auto"
                      ? `- Number of tests: ${testCount.label} — generate exactly this many test cases`    : "",
    ...(workflows.length ? [`- Perspectives:`, ...workflows.map(w => `    • ${w.instruction}`)]            : []),
    ...(qualities.length ? [`- Quality checks — include ALL of the following:`, ...qualities.map(q => `    • ${q.instruction}`)] : []),
    format            ? `- Output format: ${format.instruction}`                                           : "",
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

/**
 * resolveDialsConfig(rawConfigOrString) → validated config object | null
 *
 * Like resolveDialsPrompt but returns the validated config object so callers
 * can extract individual fields (e.g. testCount) to thread into prompt builders.
 */
export function resolveDialsConfig(input) {
  if (typeof input === "string") return null;
  return validateDialsConfig(input);
}
