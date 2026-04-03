/**
 * testDialsData.js
 *
 * Pure data definitions for Test Dials configuration.
 * No React dependency — safe to import from any module.
 */

// ─── Strategy options ──────────────────────────────────────────────────────────

export const STRATEGY_OPTIONS = [
  { id: "happy_path",    label: "Happy Path Only",         desc: "Only the expected successful flow" },
  { id: "sad_path",      label: "Sad Path & Error Handling", desc: "Focus on failures and edge errors" },
  { id: "edge_cases",    label: "Boundary & Edge Cases",   desc: "Extremes, limits, unusual inputs" },
  { id: "comprehensive", label: "Comprehensive 360 Suite", desc: "All of the above — full coverage" },
  { id: "exploratory",   label: "Exploratory Charter",     desc: "Free-form discovery testing" },
  { id: "regression",    label: "Regression Impact Analysis", desc: "Verify existing flows still work" },
];

// ─── Workflow options ──────────────────────────────────────────────────────────

export const WORKFLOW_OPTIONS = [
  { id: "e2e",            label: "End-to-End User Journey", desc: "Full flow from start to finish" },
  { id: "component",      label: "Component-Level Isolation", desc: "Single component or unit" },
  { id: "multi_role",     label: "Multi-Role Persona",      desc: "Admin, user, guest perspectives" },
  { id: "first_time_user",label: "First-Time User Experience", desc: "Onboarding, discovery, clarity" },
  { id: "interruptions",  label: "Interruptions",           desc: "Refresh, network loss, recovery" },
];

// ─── Quality check options ─────────────────────────────────────────────────────

export const QUALITY_OPTIONS = [
  { id: "accessibility",   label: "Accessibility (a11y)",  icon: "♿" },
  { id: "performance",     label: "Performance",           icon: "⚡" },
  { id: "security",        label: "Security",              icon: "🔒" },
  { id: "data_integrity",  label: "Data Integrity",        icon: "🗄" },
  { id: "api_integration", label: "API & Integration",     icon: "🔌" },
  { id: "localization",    label: "Localization (L10n)",   icon: "🌐" },
  { id: "reliability",     label: "Reliability",           icon: "🔁" },
  { id: "observability",   label: "Observability",         icon: "📊" },
];

// ─── Output format options ─────────────────────────────────────────────────────

export const FORMAT_OPTIONS = [
  { id: "verbose",  label: "Verbose Steps",        desc: "Detailed numbered steps with expected results" },
  { id: "concise",  label: "Concise Checklist",    desc: "Short bullet-point checklist" },
  { id: "gherkin",  label: "Gherkin (Given/When/Then)", desc: "BDD-style feature scenarios" },
];

// ─── Output language options ───────────────────────────────────────────────────

export const LANGUAGES = [
  { code: "en-US", label: "English (Default)", flag: "US" },
  { code: "en-GB", label: "English (UK)",      flag: "GB" },
  { code: "es",    label: "Spanish",           flag: "ES" },
  { code: "fr",    label: "French",            flag: "FR" },
  { code: "de",    label: "German",            flag: "DE" },
  { code: "ja",    label: "Japanese",          flag: "JP" },
  { code: "zh",    label: "Chinese",           flag: "CN" },
  { code: "pt",    label: "Portuguese",        flag: "PT" },
];

// ─── Default config ────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  preset: "new_feature",
  strategy: "comprehensive",
  workflow: ["e2e", "multi_role"],
  quality: [],
  format: "verbose",
  language: "en-US",
  automationHooks: false,
  customModifier: "",
};
