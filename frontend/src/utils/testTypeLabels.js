/**
 * testTypeLabels.js
 *
 * Shared mappings for industry-standard test type IDs → display labels
 * and badge CSS classes. Used by Tests.jsx (list) and TestDetail.jsx (sidebar).
 *
 * Keep in sync with the "type" enum in the backend prompt templates:
 *   backend/src/pipeline/prompts/userRequestedPrompt.js
 *   backend/src/pipeline/prompts/intentPrompt.js
 *   backend/src/pipeline/prompts/journeyPrompt.js
 */

// Full labels — used in detail views where space is available
export const TEST_TYPE_LABELS = {
  functional:    "Functional",
  smoke:         "Smoke",
  regression:    "Regression",
  e2e:           "End-to-End",
  integration:   "Integration",
  accessibility: "Accessibility",
  security:      "Security",
  performance:   "Performance",
  manual:        "Manual",
};

// Short labels — used in compact table rows
export const TEST_TYPE_SHORT_LABELS = {
  functional:    "Functional",
  smoke:         "Smoke",
  regression:    "Regression",
  e2e:           "E2E",
  integration:   "Integration",
  accessibility: "A11y",
  security:      "Security",
  performance:   "Perf",
  manual:        "Manual",
};

// Badge CSS class per type
export const TEST_TYPE_BADGE = {
  functional:    "badge-blue",
  smoke:         "badge-amber",
  regression:    "badge-blue",
  e2e:           "badge-purple",
  integration:   "badge-blue",
  accessibility: "badge-green",
  security:      "badge-red",
  performance:   "badge-amber",
  manual:        "badge-blue",
};

/**
 * Resolve the badge class for a given test type.
 * Falls back to "badge-gray" for unknown types.
 */
export function testTypeBadgeClass(type) {
  return TEST_TYPE_BADGE[type] || "badge-gray";
}

/**
 * Resolve the display label for a given test type.
 * @param {string} type — raw type id from the test object
 * @param {boolean} [short=false] — use abbreviated labels for compact views
 * @returns {string}
 */
export function testTypeLabel(type, short = false) {
  const map = short ? TEST_TYPE_SHORT_LABELS : TEST_TYPE_LABELS;
  return map[type] || type || "Unknown";
}
