/**
 * testDialsConfig.js
 *
 * Pure data definitions for Test Dials configuration options.
 * No React dependency — safe to import from any module.
 *
 * FIELD MAP (old → new):
 *   strategy        → approach          (renamed: "Coverage approach")
 *   workflow[]      → perspectives[]    (renamed: "Test perspective")
 *   quality[]       → quality[]         (unchanged — IDs & labels kept)
 *   format          → format            (IDs updated, labels plain-English)
 *   testCount       → testCount         (IDs fixed — "comprehensive" collision removed)
 *   automationHooks → options.selectorHints (expanded into options object)
 *   customModifier  → customInstructions    (renamed)
 *   preset          → profile               (renamed)
 *   (new)           → exploreMode           ("crawl" | "state" — controls Step 1 discovery)
 *   (new)           → exploreMaxStates      (5–100, state explorer budget)
 *   (new)           → exploreMaxDepth       (1–10, state explorer depth)
 *   (new)           → exploreMaxActions     (1–20, actions per state)
 *   (new)           → exploreActionTimeout  (1000–15000ms, per-action timeout)
 */

// ─── Coverage approach ─────────────────────────────────────────────────────────
// Replaces STRATEGY_OPTIONS. Old "sad_path" + "edge_cases" merged into
// "errors_and_edges" — most users lumped them together anyway.

export const APPROACH_OPTIONS = [
  {
    id: "positive_only",
    label: "Positive paths only",
    desc: "Only the expected successful flows — no error states or edge cases",
  },
  {
    id: "errors_and_edges",
    label: "Errors & edge cases",
    desc: "Invalid inputs, boundary values, failures, permission denials",
  },
  {
    id: "full_coverage",
    label: "Full coverage",
    desc: "Balanced mix — roughly 50% positive, 30% negative, 20% edge cases",
  },
  {
    id: "exploratory",
    label: "Exploratory",
    desc: "Unusual sequences and unexpected combos — find what we haven't thought of",
  },
  {
    id: "stability_check",
    label: "Stability check",
    desc: "Verify existing flows haven't broken — use after a fix or refactor",
  },
];

// ─── Test perspective ──────────────────────────────────────────────────────────
// Replaces WORKFLOW_OPTIONS. Renamed "workflow" → "perspectives".
// "Interruptions" → "interrupted_flows" for clarity.

export const PERSPECTIVE_OPTIONS = [
  {
    id: "full_journey",
    label: "Full user journey",
    desc: "Spans multiple pages — login to logout",
  },
  {
    id: "single_component",
    label: "Single component",
    desc: "One widget or section, all its interactive states",
  },
  {
    id: "multi_role",
    label: "Multiple roles",
    desc: "Admin, user, guest — each sees different things",
  },
  {
    id: "first_time_user",
    label: "First-time user",
    desc: "Onboarding, empty states, help text",
  },
  {
    id: "interrupted_flows",
    label: "Interrupted flows",
    desc: "Page refresh, back button, network drop mid-session",
  },
];

// ─── Quality checks ────────────────────────────────────────────────────────────
// IDs unchanged (backend references them). Two label fixes:
//   "API & Integration" → "API responses"  (clearer)
//   "Observability"     → "Console errors" (non-SRE users don't know "observability")

export const QUALITY_OPTIONS = [
  { id: "accessibility",   label: "Accessibility"  },
  { id: "performance",     label: "Performance"    },
  { id: "security",        label: "Security"       },
  { id: "data_integrity",  label: "Data integrity" },
  { id: "api_integration", label: "API responses"  },
  { id: "localization",    label: "Localization"   },
  { id: "reliability",     label: "Reliability"    },
  { id: "observability",   label: "Console errors" },
];

// ─── Output format ─────────────────────────────────────────────────────────────
// IDs updated to match backend rewrite. Labels now plain English.
//   "verbose"  → "step_by_step"
//   "concise"  → "checklist"
//   "gherkin"  → "gherkin" (kept)

export const FORMAT_OPTIONS = [
  {
    id: "step_by_step",
    label: "Step by step",
    desc: "Numbered actions with expected result on each line",
  },
  {
    id: "checklist",
    label: "Checklist",
    desc: "Short bullet per action — fast to read, fast to execute",
  },
  {
    id: "gherkin",
    label: "Gherkin / BDD",
    desc: "Given / When / Then — ready to paste into Cucumber or Playwright",
  },
];

// ─── Output language ───────────────────────────────────────────────────────────
// Unchanged.

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

// ─── Number of tests ───────────────────────────────────────────────────────────
// BUG FIX: old id "comprehensive" collided with STRATEGY_OPTIONS id "comprehensive".
// New IDs: one | small | medium | large | ai_decides — no collision anywhere.

export const TEST_COUNT_OPTIONS = [
  { id: "one",       label: "1",          desc: "Single focused test"       },
  { id: "small",     label: "3–5",        desc: "Small, focused set"        },
  { id: "medium",    label: "6–10",       desc: "Solid coverage"            },
  { id: "large",     label: "10–20",      desc: "Full suite"                },
  { id: "ai_decides",label: "AI decides", desc: "AI picks the right number" },
];

// ─── Explore mode ──────────────────────────────────────────────────────────────
// Controls how the crawler discovers pages/states before generating tests.
// "crawl" = legacy link-following BFS, "state" = new state-based exploration
// that executes real UI actions (click, fill, submit) and tracks transitions.

export const EXPLORE_MODE_OPTIONS = [
  {
    id: "crawl",
    label: "Link crawl",
    desc: "Follow links to discover pages — fast, good for content-heavy sites",
  },
  {
    id: "state",
    label: "State exploration",
    desc: "Execute real UI actions (click, fill, submit) to discover multi-step flows",
  },
];

// ─── Explorer intensity presets ─────────────────────────────────────────────
// Named presets that map to concrete tuning values. Shown as buttons in the
// ExploreModePicker component. "custom" is a virtual preset — selecting it
// expands the raw sliders so the user can set their own values.

export const EXPLORER_INTENSITY_PRESETS = [
  {
    id: "quick",
    label: "Quick",
    icon: "🐇",
    desc: "~1 min",
    values: { exploreMaxStates: 10, exploreMaxDepth: 2, exploreMaxActions: 4, exploreActionTimeout: 3000 },
  },
  {
    id: "balanced",
    label: "Balanced",
    icon: "⚖️",
    desc: "~2-3 min",
    values: { exploreMaxStates: 30, exploreMaxDepth: 3, exploreMaxActions: 8, exploreActionTimeout: 5000 },
    default: true,
  },
  {
    id: "deep",
    label: "Deep",
    icon: "🔬",
    desc: "~5+ min",
    values: { exploreMaxStates: 80, exploreMaxDepth: 6, exploreMaxActions: 15, exploreActionTimeout: 8000 },
  },
];

// ─── Explorer tuning (only visible when exploreMode === "state") ────────────
// Numeric sliders/inputs that control how deep and wide the state explorer goes.

export const EXPLORER_TUNING = [
  {
    id: "exploreMaxStates",
    label: "Max states",
    desc: "Maximum unique states to discover before stopping",
    min: 5, max: 100, step: 5, defaultVal: 30,
  },
  {
    id: "exploreMaxDepth",
    label: "Max depth",
    desc: "How many levels deep to explore from the start page",
    min: 1, max: 10, step: 1, defaultVal: 3,
  },
  {
    id: "exploreMaxActions",
    label: "Actions per state",
    desc: "Maximum actions to try on each discovered state",
    min: 1, max: 20, step: 1, defaultVal: 8,
  },
  {
    id: "exploreActionTimeout",
    label: "Action timeout (ms)",
    desc: "How long to wait for each click/fill/submit to take effect",
    min: 1000, max: 15000, step: 1000, defaultVal: 5000,
  },
];

// ─── Parallel execution ────────────────────────────────────────────────────────
// Controls how many tests run concurrently during a test run.
// 1 = sequential (legacy), up to 10 parallel browser contexts.

export const PARALLEL_WORKERS_TUNING = {
  id: "parallelWorkers",
  label: "Parallel workers",
  desc: "Number of tests to run simultaneously — higher values speed up large suites",
  min: 1, max: 10, step: 1, defaultVal: 1,
};

// ─── Extra options ─────────────────────────────────────────────────────────────
// Replaces single automationHooks boolean. Expanded into named toggles.

export const OPTION_TOGGLES = [
  {
    id: "selectorHints",
    label: "Add selector hints",
    desc: "Suggests data-testid attributes — useful when handing tests to an automation engineer",
  },
  {
    id: "preconditions",
    label: "Include preconditions",
    desc: "States required setup before each test (logged-in user, specific data, etc.)",
  },
  {
    id: "testDataExamples",
    label: "Include test data examples",
    desc: "Provides sample values (emails, IDs, amounts) so tests are runnable immediately",
  },
  {
    id: "markPriority",
    label: "Flag high-priority tests",
    desc: "Labels the most critical tests as P1 so teams know where to start",
  },
];

// ─── Quick profiles ────────────────────────────────────────────────────────────
// Moved here from TestDials.jsx (no JSX needed — pure data).
// "Smoke Test" removed — replaced by "Quick sanity check" (plain English, same intent).
// "Regression Guard" kept as label but maps to approach "stability_check" so it no
// longer clashes with the old strategy option "Regression Impact Analysis".

export const PROFILE_OPTIONS = [
  {
    id: "new_feature",
    label: "New feature",
    desc: "Shipping something new — cover positive, negative, and edge cases",
    approach: "full_coverage",
    perspectives: ["full_journey", "multi_role"],
    quality: ["data_integrity"],
    format: "step_by_step",
    testCount: "ai_decides",
    default: true,
  },
  {
    id: "quick_check",
    label: "Quick sanity check",
    desc: "Before a deploy — verify the most critical flows still work",
    approach: "positive_only",
    perspectives: ["full_journey"],
    quality: [],
    format: "checklist",
    testCount: "small",
  },
  {
    id: "after_bugfix",
    label: "After a bug fix",
    desc: "Confirm the fix holds and nothing nearby broke",
    approach: "stability_check",
    perspectives: ["full_journey"],
    quality: ["reliability"],
    format: "checklist",
    testCount: "small",
  },
  {
    id: "edge_hardening",
    label: "Edge case hardening",
    desc: "Push the limits — invalid inputs, broken sessions, boundary values",
    approach: "errors_and_edges",
    perspectives: ["interrupted_flows"],
    quality: ["security", "reliability"],
    format: "step_by_step",
    testCount: "medium",
  },
  {
    id: "accessibility_review",
    label: "Accessibility review",
    desc: "WCAG 2.1 — keyboard nav, screen readers, focus indicators",
    approach: "full_coverage",
    perspectives: ["first_time_user"],
    quality: ["accessibility"],
    format: "step_by_step",
    testCount: "medium",
  },
  {
    id: "api_contracts",
    label: "API & data layer",
    desc: "Integration points, request/response shapes, data persistence",
    approach: "full_coverage",
    perspectives: ["multi_role"],
    quality: ["api_integration", "data_integrity"],
    format: "checklist",
    testCount: "small",
  },
  {
    id: "bdd_spec",
    label: "BDD / automation spec",
    desc: "Gherkin-formatted scenarios ready for Cucumber or Playwright",
    approach: "full_coverage",
    perspectives: ["full_journey", "multi_role"],
    quality: [],
    format: "gherkin",
    testCount: "medium",
  },
];

// ─── Default config ────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  profile:      "new_feature",
  approach:     "full_coverage",
  perspectives: ["full_journey", "multi_role"],
  quality:      ["data_integrity"],
  format:       "step_by_step",
  testCount:    "ai_decides",
  exploreMode:          "crawl",
  exploreMaxStates:     30,
  exploreMaxDepth:      3,
  exploreMaxActions:    8,
  exploreActionTimeout: 5000,
  parallelWorkers:      1,
  options: {
    selectorHints:    false,
    preconditions:    false,
    testDataExamples: false,
    markPriority:     false,
  },
  language:           "en-US",
  customInstructions: "",
};
