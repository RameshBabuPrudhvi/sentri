/**
 * testDials.js — Server-side Test Dials: validation + prompt builder
 *
 * The frontend sends a structured config object. This module validates it
 * against known option IDs and builds the prompt fragment injected into AI
 * calls. Keeping this server-side means:
 *
 *   1. The backend controls what text reaches the AI — no prompt injection risk.
 *   2. The same builder can be reused by backend-only flows (scheduled runs, API).
 *   3. Unknown / malicious option IDs are silently dropped.
 *   4. customInstructions is length-capped and stripped of injection markers.
 *
 * FIELD MAP (old → new, mirrored from frontend testDialsConfig.js):
 *   strategy        → approach
 *   workflow[]      → perspectives[]
 *   format ids      → step_by_step | checklist | gherkin  (was verbose|concise|gherkin)
 *   testCount ids   → one|small|medium|large|ai_decides   (was single|few|moderate|comprehensive|auto)
 *   automationHooks → options.selectorHints
 *   customModifier  → customInstructions
 */

// ─── Canonical option definitions ──────────────────────────────────────────────

export const APPROACH_OPTIONS = [
  {
    id: "positive_only",
    label: "Positive paths only",
    instruction: "Generate ONLY positive/happy-path tests — every test must follow the expected successful user flow from start to finish. Do NOT include error handling, validation failures, or edge cases.",
  },
  {
    id: "errors_and_edges",
    label: "Errors & edge cases",
    instruction: "Focus on NEGATIVE and EDGE-CASE tests — invalid inputs, missing required fields, wrong credentials, expired sessions, maximum-length inputs, special characters (unicode, SQL injection strings), zero-quantity values, rapid repeated clicks, and race conditions. Every test must push the application to its limits or trigger a clear error state.",
  },
  {
    id: "full_coverage",
    label: "Full coverage",
    instruction: "Generate a BALANCED mix of positive (happy path), negative (error handling), and edge-case tests. Aim for roughly 50% positive, 30% negative, and 20% edge cases. Cover the full spectrum of user interactions on the page.",
  },
  {
    id: "exploratory",
    label: "Exploratory",
    instruction: "Generate EXPLORATORY tests that probe unexpected user behaviours — unusual navigation sequences, interacting with elements in non-obvious order, combining features in ways a typical user would not, and verifying the application recovers gracefully from unexpected states.",
  },
  {
    id: "stability_check",
    label: "Stability check",
    instruction: "Generate REGRESSION tests that verify existing core functionality still works correctly. Focus on the most critical user flows (login, checkout, data submission, navigation) and assert that their expected outcomes have not changed. Prioritise stability assertions (URLs, key text, element visibility) over exploratory coverage.",
  },
];

export const PERSPECTIVE_OPTIONS = [
  {
    id: "full_journey",
    label: "Full user journey",
    instruction: "Tests must span multiple pages/steps as a complete user flow (e.g. login → dashboard → action → logout). Assert outcomes at each transition point.",
  },
  {
    id: "single_component",
    label: "Single component",
    instruction: "Tests must focus on a SINGLE component or widget in isolation — test all its interactive states (default, hover, active, disabled, error) without navigating away from the current page.",
  },
  {
    id: "multi_role",
    label: "Multiple roles",
    instruction: "Generate separate tests for DIFFERENT user roles (e.g. admin, regular user, guest/unauthenticated). Each test must assert role-specific behaviour — elements visible to admin but hidden from guest, restricted actions returning permission errors, etc.",
  },
  {
    id: "first_time_user",
    label: "First-time user",
    instruction: "Tests must simulate a BRAND-NEW user who has never seen the application — verify onboarding flows, empty states, tooltip/help text visibility, and that the first interaction path is intuitive and error-free.",
  },
  {
    id: "interrupted_flows",
    label: "Interrupted flows",
    instruction: "Tests must simulate INTERRUPTED flows — page refresh mid-form, browser back button during checkout, network disconnect/reconnect, session timeout during a multi-step process. Assert the application recovers gracefully or preserves user data.",
  },
];

export const QUALITY_OPTIONS = [
  {
    id: "accessibility",
    label: "Accessibility",
    instruction: "Include accessibility assertions: verify ARIA roles/labels are present on interactive elements, check keyboard navigation (Tab order, Enter/Space activation), assert focus indicators are visible, and verify screen-reader-friendly alt text on images. Use getByRole() selectors to confirm semantic HTML.",
  },
  {
    id: "performance",
    label: "Performance",
    instruction: "Add performance assertions: verify that key pages load within acceptable timeouts, assert that large lists or images use lazy loading (elements appear on scroll), and check that no critical resource requests return 4xx/5xx status codes in the network log.",
  },
  {
    id: "security",
    label: "Security",
    instruction: "Include security tests: attempt XSS payloads (<script>alert(1)</script>) in input fields and assert they are escaped/rejected, verify that sensitive pages redirect unauthenticated users to login, check that password fields mask input, and assert that CSRF tokens or auth headers are present on form submissions.",
  },
  {
    id: "data_integrity",
    label: "Data integrity",
    instruction: "Include data integrity assertions: after creating/editing a record, reload the page and assert the data persists correctly. Verify that numeric fields reject non-numeric input, date fields enforce valid ranges, and that duplicate submissions are blocked or handled idempotently.",
  },
  {
    id: "api_integration",
    label: "API responses",
    instruction: "Include API-level assertions: use page.waitForResponse() to intercept key API calls and assert they return 2xx status codes with expected response shapes. Verify that form submissions trigger the correct backend endpoints and that error responses from the API surface as user-visible messages.",
  },
  {
    id: "localization",
    label: "Localization",
    instruction: "Include localization checks: verify that UI text does not overflow containers, assert that date/number formats match the expected locale, and check that translated strings are present and not showing raw i18n keys like 'common.submit'.",
  },
  {
    id: "reliability",
    label: "Reliability",
    instruction: "Include reliability tests: test behaviour after page refresh mid-flow, verify that error recovery paths return the user to a usable state, and assert that concurrent operations (e.g. two tabs) do not corrupt shared state.",
  },
  {
    id: "observability",
    label: "Console errors",
    instruction: "Assert no JavaScript errors or uncaught exceptions occur during the test flow (page.on('console') / page.on('pageerror')). Verify that key analytics or telemetry events fire if observable via network requests.",
  },
];

export const FORMAT_OPTIONS = [
  {
    id: "step_by_step",
    label: "Step by step",
    instruction: "Format each test with DETAILED numbered steps — each step must include the exact user action AND the expected result. Example: '1. Click the \"Submit\" button → A success toast appears with text \"Saved successfully\"'.",
  },
  {
    id: "checklist",
    label: "Checklist",
    instruction: "Format each test as a SHORT bullet-point checklist — one line per action/assertion, no prose. Example: '• Fill email → valid@test.com • Click Submit • Assert: success message visible'.",
  },
  {
    id: "gherkin",
    label: "Gherkin / BDD",
    instruction: "Format each test's steps using strict Gherkin syntax: 'Given [precondition]', 'When [action]', 'Then [expected outcome]', with 'And' for additional clauses. Each step must start with exactly one of these keywords.",
  },
];

export const LANGUAGES = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "es",    label: "Spanish"      },
  { code: "fr",    label: "French"       },
  { code: "de",    label: "German"       },
  { code: "ja",    label: "Japanese"     },
  { code: "zh",    label: "Chinese"      },
  { code: "pt",    label: "Portuguese"   },
];

// FIX: old "comprehensive" id collided with the strategy option of the same id.
// New ids: one | small | medium | large | ai_decides
export const TEST_COUNT_OPTIONS = [
  { id: "one",       label: "1"          },
  { id: "small",     label: "3–5"        },
  { id: "medium",    label: "6–10"       },
  { id: "large",     label: "10–20"      },
  { id: "ai_decides",label: "AI decides" },
];

// ─── Validation sets ────────────────────────────────────────────────────────────

const VALID_APPROACHES   = new Set(APPROACH_OPTIONS.map(a => a.id));
const VALID_PERSPECTIVES = new Set(PERSPECTIVE_OPTIONS.map(p => p.id));
const VALID_QUALITIES    = new Set(QUALITY_OPTIONS.map(q => q.id));
const VALID_FORMATS      = new Set(FORMAT_OPTIONS.map(f => f.id));
const VALID_LANGUAGES    = new Set(LANGUAGES.map(l => l.code));
const VALID_TEST_COUNTS  = new Set(TEST_COUNT_OPTIONS.map(t => t.id));

const VALID_OPTION_KEYS  = new Set(["selectorHints", "preconditions", "testDataExamples", "markPriority"]);

const CUSTOM_MAX_LENGTH  = 500;

// ─── Validate & sanitise ────────────────────────────────────────────────────────

/**
 * validateDialsConfig(raw) → sanitised config object | null
 *
 * Drops unknown IDs silently. Caps customInstructions at 500 chars.
 * Returns null when input is falsy or not an object.
 */
// ─── Backward-compat migration maps ─────────────────────────────────────────
// Stale clients (cached browser tabs that haven't refreshed) may still send the
// old field names / option IDs.  We migrate them in-place before validation so
// the user's intent is preserved instead of silently dropped.

const APPROACH_MIGRATION = {
  happy_path: "positive_only", sad_path: "errors_and_edges",
  edge_cases: "errors_and_edges", comprehensive: "full_coverage",
  regression: "stability_check",
};
const FORMAT_MIGRATION    = { verbose: "step_by_step", concise: "checklist" };
const COUNT_MIGRATION     = { single: "one", few: "small", moderate: "medium", comprehensive: "large", auto: "ai_decides" };
const PERSPECTIVE_MIGRATION = { e2e: "full_journey", component: "single_component", interruptions: "interrupted_flows" };

function migrateRaw(raw) {
  // Migrate renamed top-level field names
  if (raw.strategy    && !raw.approach)          raw.approach          = raw.strategy;
  if (raw.workflow    && !raw.perspectives)       raw.perspectives     = raw.workflow;
  if (raw.customModifier && !raw.customInstructions) raw.customInstructions = raw.customModifier;

  // Migrate automationHooks → options.selectorHints
  if (raw.automationHooks === true && !raw.options) {
    raw.options = { selectorHints: true };
  }

  // Migrate renamed option IDs
  if (raw.approach  && APPROACH_MIGRATION[raw.approach])  raw.approach  = APPROACH_MIGRATION[raw.approach];
  if (raw.format    && FORMAT_MIGRATION[raw.format])      raw.format    = FORMAT_MIGRATION[raw.format];
  if (raw.testCount && COUNT_MIGRATION[raw.testCount])    raw.testCount = COUNT_MIGRATION[raw.testCount];

  // Migrate perspective IDs inside the array
  if (Array.isArray(raw.perspectives)) {
    raw.perspectives = raw.perspectives.map(id => PERSPECTIVE_MIGRATION[id] || id);
  }
}

export function validateDialsConfig(raw) {
  if (!raw || typeof raw !== "object") return null;

  // Apply backward-compat migrations for stale clients
  migrateRaw(raw);

  const approach = VALID_APPROACHES.has(raw.approach) ? raw.approach : null;

  const perspectives = Array.isArray(raw.perspectives)
    ? raw.perspectives.filter(id => VALID_PERSPECTIVES.has(id))
    : [];

  const quality = Array.isArray(raw.quality)
    ? raw.quality.filter(id => VALID_QUALITIES.has(id))
    : [];

  const format = VALID_FORMATS.has(raw.format) ? raw.format : null;

  const language = VALID_LANGUAGES.has(raw.language) ? raw.language : "en-US";

  const testCount = VALID_TEST_COUNTS.has(raw.testCount) ? raw.testCount : "ai_decides";

  // Validate options object — only known boolean keys accepted
  const rawOpts = raw.options && typeof raw.options === "object" ? raw.options : {};
  const options = {};
  for (const key of VALID_OPTION_KEYS) {
    options[key] = rawOpts[key] === true;
  }

  // Sanitise free-text: trim, cap, strip prompt-injection markers
  let customInstructions = typeof raw.customInstructions === "string"
    ? raw.customInstructions.trim().slice(0, CUSTOM_MAX_LENGTH)
    : "";
  customInstructions = customInstructions
    .replace(/^(SYSTEM|ASSISTANT|USER|HUMAN|AI)\s*:/gim, "")
    .replace(/```/g, "")
    .trim();

  return { approach, perspectives, quality, format, language, testCount, options, customInstructions };
}

// ─── Build the prompt fragment ──────────────────────────────────────────────────

/**
 * buildDialsPrompt(cfg) → string
 *
 * Accepts a validated config and returns a prompt fragment ready to be
 * injected into an AI prompt. Returns "" when config is null or empty.
 */
export function buildDialsPrompt(cfg) {
  if (!cfg) return "";

  const approach      = APPROACH_OPTIONS.find(a => a.id === cfg.approach);
  const format        = FORMAT_OPTIONS.find(f => f.id === cfg.format);
  const testCount     = TEST_COUNT_OPTIONS.find(t => t.id === cfg.testCount);
  const perspectives  = PERSPECTIVE_OPTIONS.filter(p => (cfg.perspectives || []).includes(p.id));
  const qualities     = QUALITY_OPTIONS.filter(q => (cfg.quality || []).includes(q.id));
  const opts          = cfg.options || {};

  const lines = [
    "TEST GENERATION CONFIGURATION:",
    approach
      ? `- Coverage approach: ${approach.instruction}`
      : "",
    testCount && cfg.testCount !== "ai_decides"
      ? `- Number of tests: ${testCount.label} — generate exactly this many test cases`
      : "",
    ...(perspectives.length
      ? ["- Test perspectives — write tests from ALL of the following angles:",
         ...perspectives.map(p => `    • ${p.instruction}`)]
      : []),
    ...(qualities.length
      ? ["- Quality checks — include ALL of the following assertion types:",
         ...qualities.map(q => `    • ${q.instruction}`)]
      : []),
    format
      ? `- Output format: ${format.instruction}`
      : "",
    cfg.language && cfg.language !== "en-US"
      ? `- Output language: ${LANGUAGES.find(l => l.code === cfg.language)?.label ?? cfg.language}`
      : "",
    opts.selectorHints
      ? "- Add selector hints: suggest a data-testid attribute for each interactive element referenced in a step."
      : "",
    opts.preconditions
      ? "- Include preconditions: before each test case, state the required setup (user role, data state, browser context)."
      : "",
    opts.testDataExamples
      ? "- Include test data examples: provide concrete sample values (e.g. email addresses, numeric IDs, dollar amounts) so tests can be executed immediately without modification."
      : "",
    opts.markPriority
      ? "- Flag high-priority tests: prefix the most business-critical test cases with [P1] so teams know where to focus first."
      : "",
    cfg.customInstructions
      ? `- Additional instructions from the user: ${cfg.customInstructions}`
      : "",
  ].filter(Boolean);

  return lines.length > 1 ? lines.join("\n") : "";
}

// ─── Convenience entry-points ───────────────────────────────────────────────────

/**
 * resolveDialsPrompt(rawConfig) → string
 *
 * Single entry-point for route handlers. Rejects raw strings to prevent
 * prompt injection — only structured config objects are accepted.
 */
export function resolveDialsPrompt(input) {
  if (typeof input === "string") return "";
  return buildDialsPrompt(validateDialsConfig(input));
}

/**
 * resolveDialsConfig(rawConfig) → validated config | null
 *
 * Like resolveDialsPrompt but returns the config object so callers can
 * extract individual fields (e.g. testCount) directly.
 */
export function resolveDialsConfig(input) {
  if (typeof input === "string") return null;
  return validateDialsConfig(input);
}
