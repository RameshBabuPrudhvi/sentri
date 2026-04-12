/**
 * @module pipeline/actionDiscovery
 * @description Discovers actionable UI elements on a page and produces
 * executable Action descriptors for the state explorer.
 *
 * Builds on top of the existing element data captured by
 * {@link module:pipeline/pageSnapshot.takeSnapshot} and the scoring logic
 * in {@link module:pipeline/elementFilter.scoreElement}. Instead of just
 * filtering elements for AI prompt context, this module determines *what
 * actions can be performed* on each element.
 *
 * ### Action types
 * | Type     | Elements                                          |
 * |----------|---------------------------------------------------|
 * | `click`  | buttons, links, tabs, menu items, role="button"   |
 * | `fill`   | text inputs, email, password, search, tel, number  |
 * | `select` | `<select>` dropdowns, role="combobox"              |
 * | `submit` | submit buttons, form submit actions                |
 * | `check`  | checkboxes, radio buttons, switches                |
 *
 * ### Exports
 * - {@link discoverActions} — `(snapshot) → Action[]`
 * - {@link generateTestData} — `(field) → string`
 */

// Keywords that signal destructive / irreversible actions — these are
// deprioritised so the explorer doesn't accidentally delete data.
// Reuses the same keyword awareness as elementFilter.js HIGH_VALUE_BUTTON_KEYWORDS
// but inverted: these are *dangerous* rather than *valuable*.
const DESTRUCTIVE_KEYWORDS = [
  "delete", "remove", "destroy", "reset", "clear all",
  "unsubscribe", "deactivate", "close account",
];

// S3-08: keywords that signal a signup / registration form requiring email
// verification. Used by stateExplorer to decide whether to invoke the
// DisposableEmail flow instead of plain form-filling.
const SIGNUP_INTENT_KEYWORDS = [
  "sign up", "signup", "register", "registration", "create account",
  "create your account", "join", "get started", "open an account",
];

/**
 * detectSignupIntent(snapshot, formActions) → boolean
 *
 * Returns true if the given form actions appear to belong to a
 * signup/registration flow that will likely require email verification.
 * Checks:
 *   1. Submit/click button text on the form
 *   2. Page title / heading text in the snapshot
 *   3. Presence of both an email field AND a password field (strong signal)
 *
 * @param {object} snapshot     - Page snapshot from takeSnapshot
 * @param {object[]} formActions - Action descriptors for a single form group
 * @returns {boolean}
 */
export function detectSignupIntent(snapshot, formActions) {
  // Signal 1: submit button text
  const submitActions = formActions.filter(a => a.type === "submit" || a.type === "click");
  const submitText = submitActions.map(a => (a.element?.text || "")).join(" ").toLowerCase();
  if (SIGNUP_INTENT_KEYWORDS.some(k => submitText.includes(k))) return true;

  // Signal 2: page title or h1/h2 heading
  const pageText = `${snapshot?.title || ""} ${snapshot?.url || ""}`.toLowerCase();
  if (SIGNUP_INTENT_KEYWORDS.some(k => pageText.includes(k))) return true;

  // Signal 3: form contains BOTH an email field and a password field
  const hasEmail    = formActions.some(a => a.type === "fill" && (a.element?.type === "email"    || (a.element?.placeholder || "").toLowerCase().includes("email")));
  const hasPassword = formActions.some(a => a.type === "fill" && (a.element?.type === "password" || (a.element?.placeholder || "").toLowerCase().includes("password")));
  if (hasEmail && hasPassword) return true;

  return false;
}

// ── Test data generators ────────────────────────────────────────────────────

const TEST_DATA = {
  email:    "sentri-test@example.com",
  password: "SentriTest123!",
  text:     "Sentri test input",
  search:   "test query",
  tel:      "+1234567890",
  number:   "42",
  url:      "https://example.com",
  date:     "2025-01-15",
};

/**
 * Generate a realistic test value for a form field based on its type,
 * name, label, and placeholder.
 *
 * @param {object} field — element descriptor from pageSnapshot
 * @returns {string} a plausible test value
 */
export function generateTestData(field) {
  const type = (field.type || "").toLowerCase();
  const hints = `${field.name || ""} ${field.label || ""} ${field.placeholder || ""} ${field.ariaLabel || ""}`.toLowerCase();

  // Type-based matching first (strongest signal)
  if (type === "email" || hints.includes("email")) return TEST_DATA.email;
  if (type === "password" || hints.includes("password")) return TEST_DATA.password;
  if (type === "search" || hints.includes("search")) return TEST_DATA.search;
  if (type === "tel" || hints.includes("phone")) return TEST_DATA.tel;
  if (type === "number" || hints.includes("amount") || hints.includes("quantity")) return TEST_DATA.number;
  if (type === "url") return TEST_DATA.url;
  if (type === "date") return TEST_DATA.date;

  // Hint-based matching
  if (hints.includes("name") || hints.includes("first") || hints.includes("last")) return "Jane Doe";
  if (hints.includes("address") || hints.includes("street")) return "123 Test Street";
  if (hints.includes("city")) return "Test City";
  if (hints.includes("zip") || hints.includes("postal")) return "12345";
  if (hints.includes("company") || hints.includes("organization")) return "Sentri Corp";
  if (hints.includes("message") || hints.includes("comment") || hints.includes("description")) {
    return "This is a test message from Sentri explorer.";
  }

  return TEST_DATA.text;
}

// ── Action type resolution ──────────────────────────────────────────────────

/**
 * Determine the action type for an element based on its tag, type, and role.
 *
 * @param {object} el — element descriptor from pageSnapshot
 * @returns {string|null} action type or null if not actionable
 */
function resolveActionType(el) {
  const tag = (el.tag || "").toLowerCase();
  const type = (el.type || "").toLowerCase();
  const role = (el.role || "").toLowerCase();

  // Form inputs → fill
  if (tag === "textarea") return "fill";
  if (tag === "input") {
    if (["text", "email", "password", "search", "tel", "number", "url", "date", ""].includes(type)) return "fill";
    if (["checkbox", "radio"].includes(type)) return "check";
    if (type === "submit") return "submit";
    if (type === "button") return "click";
    return null; // hidden, file, etc. — skip
  }

  // Select → select
  if (tag === "select" || role === "combobox" || role === "listbox") return "select";

  // Checkable roles
  if (["checkbox", "radio", "switch"].includes(role)) return "check";

  // Submit buttons inside forms
  if (tag === "button") {
    if (type === "submit") return "submit";
    // Buttons with submit-like text
    const text = (el.text || "").toLowerCase();
    if (el.formId && /submit|send|save|create|sign|log\s?in|register/i.test(text)) return "submit";
    return "click";
  }

  // Links
  if (tag === "a" && el.href) return "click";

  // ARIA interactive roles
  if (["button", "link", "menuitem", "tab", "option"].includes(role)) return "click";

  return null;
}

// ── Selector strategy builder ───────────────────────────────────────────────
// Produces multiple selector strategies per element, ordered by resilience.
// Mirrors the self-healing waterfall in selfHealing.js (safeClick/safeFill).

/**
 * Build an ordered list of Playwright selector strings for an element.
 * The explorer tries them in order; the first that resolves wins.
 *
 * @param {object} el — element descriptor
 * @param {string} actionType
 * @returns {string[]} selector strings
 */
function buildSelectors(el, actionType) {
  const selectors = [];
  const text = (el.text || "").trim();
  const label = (el.label || "").trim();
  const placeholder = (el.placeholder || "").trim();
  const ariaLabel = (el.ariaLabel || "").trim();
  const testId = (el.testId || "").trim();
  const role = (el.role || "").toLowerCase();
  const name = (el.name || "").trim();
  const id = (el.id || "").trim();

  // 1. data-testid (most stable)
  if (testId) selectors.push(`[data-testid="${testId}"]`);

  // 2. Role-based (aligns with self-healing waterfall)
  if (role && text) selectors.push(`role=${role}[name="${text}"]`);

  // 3. Label (for inputs)
  if (label) selectors.push(`label=${label}`);

  // 4. Placeholder
  if (placeholder) selectors.push(`placeholder=${placeholder}`);

  // 5. aria-label
  if (ariaLabel) selectors.push(`[aria-label="${ariaLabel}"]`);

  // 6. Text content (for buttons/links)
  if (text && actionType === "click") selectors.push(`text="${text}"`);

  // 7. ID-based
  if (id) selectors.push(`#${id}`);

  // 8. Name attribute
  if (name) selectors.push(`[name="${name}"]`);

  return selectors;
}

// ── Priority scoring ────────────────────────────────────────────────────────
// Reuses the same value signals as elementFilter.js HIGH_VALUE_BUTTON_KEYWORDS
// but adapted for action prioritisation.

/**
 * Score an action for exploration priority. Higher = explore first.
 *
 * @param {object} el — element descriptor
 * @param {string} actionType
 * @returns {number} 0–100
 */
function scoreAction(el, actionType) {
  const text = (el.text || "").toLowerCase();
  let score = 50; // base

  // Submit actions are highest value — they trigger state transitions
  if (actionType === "submit") score += 30;

  // Form fills are high value — they set up state for submissions
  if (actionType === "fill") score += 20;

  // Login/auth interactions
  if (/login|sign\s?in|register|sign\s?up|password/.test(text)) score += 25;

  // Checkout/purchase
  if (/checkout|buy|purchase|add to cart|pay/.test(text)) score += 20;

  // Search
  if (/search|find|filter/.test(text)) score += 15;

  // CRUD
  if (/create|new|add|edit|save|update/.test(text)) score += 15;

  // Navigation CTAs
  if (/get started|try|start|learn more|view/.test(text)) score += 10;

  // Penalise destructive actions
  if (DESTRUCTIVE_KEYWORDS.some(k => text.includes(k))) score -= 40;

  // Penalise disabled elements
  if (el.disabled) score -= 50;

  // Bonus for elements with test IDs (more reliable selectors)
  if (el.testId) score += 5;

  // Bonus for required fields (more likely to be in critical flows)
  if (el.required) score += 10;

  return Math.max(0, Math.min(100, score));
}

// ── Main export ─────────────────────────────────────────────────────────────

/**
 * Discover all actionable elements on a page and produce Action descriptors.
 *
 * @param {object} snapshot — page snapshot from {@link module:pipeline/pageSnapshot.takeSnapshot}
 * @returns {Array<{
 *   type: string,
 *   selectors: string[],
 *   element: object,
 *   value: string|null,
 *   priority: number,
 *   isDestructive: boolean,
 *   formId: string
 * }>} sorted by priority (highest first)
 */
export function discoverActions(snapshot) {
  const actions = [];
  const seen = new Set(); // deduplicate by tag:type:text

  for (const el of (snapshot.elements || [])) {
    // Skip invisible and disabled elements
    if (el.visible === false) continue;

    const actionType = resolveActionType(el);
    if (!actionType) continue;

    // Pre-filter cross-origin links — avoids the expensive click → wait →
    // reject → restore cycle in the state explorer. The href is already
    // available from pageSnapshot, so we can check origin without clicking.
    if (actionType === "click" && (el.tag || "").toLowerCase() === "a" && el.href) {
      try {
        const linkHost = new URL(el.href, snapshot.url).hostname.replace(/^www\./i, "").toLowerCase();
        const pageHost = new URL(snapshot.url).hostname.replace(/^www\./i, "").toLowerCase();
        if (linkHost !== pageHost) continue; // skip — will always be rejected by origin guard
      } catch { /* keep action if URL parsing fails */ }
    }

    // Deduplicate — same pattern as elementFilter.js
    const key = `${el.tag}:${el.type}:${(el.text || "").toLowerCase().trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const text = (el.text || "").toLowerCase();
    const isDestructive = DESTRUCTIVE_KEYWORDS.some(k => text.includes(k));
    const selectors = buildSelectors(el, actionType);
    if (selectors.length === 0) continue; // no way to target this element

    const priority = scoreAction(el, actionType);

    actions.push({
      type: actionType,
      selectors,
      element: {
        tag: el.tag,
        text: (el.text || "").slice(0, 80),
        type: el.type || "",
        role: el.role || "",
        name: el.name || "",
        id: el.id || "",
        label: el.label || "",
        placeholder: el.placeholder || "",
        ariaLabel: el.ariaLabel || "",
        testId: el.testId || "",
        formId: el.formId || "",
      },
      value: actionType === "fill" ? generateTestData(el) : null,
      priority,
      isDestructive,
      formId: el.formId || "",
    });
  }

  // Sort by priority descending (highest-value actions explored first)
  return actions.sort((a, b) => b.priority - a.priority);
}
