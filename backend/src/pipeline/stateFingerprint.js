/**
 * @module pipeline/stateFingerprint
 * @description State fingerprinting for the state-based exploration engine.
 *
 * Produces a deterministic fingerprint of the current browser state that goes
 * beyond the existing {@link module:pipeline/smartCrawl.fingerprintStructure}
 * (which only hashes element tags). A state fingerprint captures:
 *   - URL route (pathname + hash, with significant query params)
 *   - Route param pattern (numeric segments normalised to `:id`)
 *   - DOM structural shape (reuses smartCrawl.fingerprintStructure)
 *   - Visible text content hash (with dynamic value normalisation)
 *   - UI component inventory (modals, sidebars, dropdowns, toasts, etc.)
 *   - SPA framework markers and loading/error states
 *   - Form field states (empty vs filled vs error)
 *
 * Two states are considered identical when their fingerprints match, preventing
 * infinite exploration loops and detecting meaningful transitions.
 *
 * ### Exports
 * - {@link fingerprintState} — `(snapshot) → string`
 * - {@link statesEqual} — `(fp1, fp2) → boolean`
 */

import { fingerprintStructure } from "./smartCrawl.js";

/**
 * Simple deterministic hash — reuses the same algorithm as
 * {@link module:pipeline/smartCrawl.fingerprintStructure} and
 * {@link module:pipeline/deduplicator.simpleHash}.
 *
 * @param {string} str
 * @returns {string} base-36 hash
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// ── Query parameter handling (#52 defect #1) ─────────────────────────────────

/**
 * Query parameter names that carry state-significant meaning.
 * These are included in the route fingerprint; all others are stripped to
 * avoid fingerprint explosion from tracking tokens, cache busters, etc.
 */
const SIGNIFICANT_PARAMS = new Set([
  "category", "sort", "order", "view", "tab", "page", "filter",
  "type", "status", "q", "query", "search", "mode", "step",
  "section", "panel", "lang", "locale",
]);

/**
 * Query parameter patterns that are always noise (session tokens, analytics,
 * cache busters). These are stripped even if they happen to match a
 * significant name in a future extension.
 */
const NOISE_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^_ga$/i, /^mc_/i,
  /^ref$/i, /^source$/i, /token/i, /session/i, /nonce/i,
  /timestamp/i, /^_$/i, /^cb$/i, /^t$/i,
];

/**
 * Extract the route portion of a URL with significant query params.
 *
 * Normalises trailing slashes so `/about/` and `/about` fingerprint the same.
 * Numeric path segments are normalised to `:id` so `/users/123` and
 * `/users/456` produce the same route pattern (#52 defect #2).
 * Significant query params (category, sort, view, etc.) are included in
 * sorted order; noise params are stripped (#52 defect #1).
 *
 * @param {string} url
 * @returns {string}
 */
function extractRoute(url) {
  try {
    const u = new URL(url);
    // Normalise numeric path segments to `:id` (#52 defect #2)
    const path = u.pathname
      .replace(/\/+$/, "")
      .split("/")
      .map(seg => /^\d+$/.test(seg) ? ":id" : seg)
      .join("/") || "/";

    // Include significant query params in sorted order (#52 defect #1)
    const sigParams = [];
    for (const [key, value] of u.searchParams) {
      if (NOISE_PARAMS.some(re => re.test(key))) continue;
      if (SIGNIFICANT_PARAMS.has(key.toLowerCase())) {
        sigParams.push(`${key.toLowerCase()}=${value}`);
      }
    }
    sigParams.sort();
    const qStr = sigParams.length > 0 ? `?${sigParams.join("&")}` : "";

    return `${u.hostname}${path}${u.hash}${qStr}`;
  } catch { return url; }
}

// ── Dynamic text normalisation (#52 defect #5) ──────────────────────────────

/**
 * Normalise dynamic text fragments in a string.
 *
 * Strips order/ticket numbers, counts with units, currency amounts,
 * timestamps, and other dynamic values that would cause trivially different
 * fingerprints for the same logical state (#52 defect #5).
 *
 * @param {string} text
 * @returns {string}
 */
function normaliseDynamicText(text) {
  return text
    .replace(/#\d+/g, "#_")                          // "Order #12345" → "Order #_"
    .replace(/\b\d+\s*items?\b/gi, "_ items")        // "2 items" → "_ items"
    .replace(/\$[\d,.]+/g, "$_")                      // "$19.99" → "$_"
    .replace(/€[\d,.]+/g, "€_")                       // "€9.99" → "€_"
    .replace(/£[\d,.]+/g, "£_")                       // "£9.99" → "£_"
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/gi, "_time_") // "2:30 PM"
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, "_date_")     // "04/19/2026"
    .replace(/\(\d+\)/g, "(_)")                       // "(3)" notification counts
    .replace(/\b\d+\s*new\b/gi, "_ new")              // "3 new"
    .replace(/\b\d{4,}\b/g, "_num_")                  // long numbers (IDs, phone)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Hash the visible text content from a snapshot's elements.
 *
 * Only uses STRUCTURAL text signals (headings, button labels, link text) — not
 * dynamic content like timestamps, counters, or personalised greetings. This
 * prevents trivially different snapshots of the same page (e.g. google.com
 * with different doodle text) from being treated as distinct states.
 *
 * Dynamic values (order numbers, counts, prices) are normalised before hashing
 * so "Order #12345" and "Order #12346" produce the same hash (#52 defect #5).
 *
 * @param {Array} elements
 * @returns {string}
 */
function hashVisibleContent(elements) {
  const text = (elements || [])
    .filter(el => {
      if (el.visible === false) return false;
      // Only include structural text: headings, buttons, links, labels
      const tag = (el.tag || "").toLowerCase();
      const role = (el.role || "").toLowerCase();
      return ["button", "a", "h1", "h2", "h3", "label"].includes(tag)
        || ["button", "link", "tab", "menuitem"].includes(role);
    })
    .map(el => normaliseDynamicText((el.text || "").slice(0, 30).toLowerCase()))
    .filter(t => t.length > 2) // skip tiny fragments like "×" or "OK"
    .join("|");
  return simpleHash(text);
}

/**
 * Compute a form-state signature from the snapshot's formStructures.
 * Captures which fields are filled vs empty and whether required fields
 * have values — this distinguishes "clean form" from "form with errors".
 *
 * @param {Array} formStructures — from pageSnapshot.js
 * @returns {string}
 */
function formStateSignature(formStructures) {
  if (!formStructures || formStructures.length === 0) return "no_forms";
  return formStructures.map(form => {
    const fields = (form.fields || []).map(f => {
      const state = f.required ? "req" : "opt";
      return `${f.tag}:${f.type || "text"}:${state}`;
    }).join(",");
    return `${form.id}[${fields}]`;
  }).join("|");
}

// ── UI component inventory (#52 defect #3) ──────────────────────────────────

/**
 * Build a sorted, deterministic inventory of visible UI component types.
 *
 * Goes beyond the original `hasModals` / `hasTabs` boolean flags to enumerate
 * the full set of component types present on the page. This ensures that
 * two pages with the same headings but different component layouts (e.g.
 * sidebar visible vs collapsed) produce different fingerprints.
 *
 * @param {object} snapshot — page snapshot from takeSnapshot
 * @returns {string} sorted component inventory string
 */
function componentInventory(snapshot) {
  const components = [];
  if (snapshot.hasModals) components.push("modal");
  if (snapshot.hasTabs) components.push("tabs");
  if (snapshot.hasTable) components.push("table");
  if (snapshot.hasSidebar) components.push("sidebar");
  if (snapshot.hasDropdown) components.push("dropdown");
  if (snapshot.hasToast) components.push("toast");
  if (snapshot.hasAccordion) components.push("accordion");
  if (snapshot.hasLoginForm) components.push("login");
  // Loading / error / empty states (#52 defect #4)
  if (snapshot.hasSpinner) components.push("loading");
  if (snapshot.hasErrorState) components.push("error");
  if (snapshot.hasEmptyState) components.push("empty");
  // SPA framework markers (#52 defect #4)
  if (snapshot.spaFramework) components.push(`spa:${snapshot.spaFramework}`);
  components.sort();
  return components.length > 0 ? components.join(",") : "none";
}

/**
 * Produce a deterministic fingerprint of the current application state.
 *
 * Combines route (with significant query params and normalised path params),
 * DOM structure, visible content (with dynamic value normalisation), UI
 * component inventory, SPA markers, and form state into a single hash string.
 * Used by the state explorer to detect whether an action caused a meaningful
 * state transition.
 *
 * @param {object} snapshot — page snapshot from {@link module:pipeline/pageSnapshot.takeSnapshot}
 * @returns {string} deterministic fingerprint string
 */
export function fingerprintState(snapshot) {
  const route = extractRoute(snapshot.url);
  const structure = fingerprintStructure(snapshot);
  const content = hashVisibleContent(snapshot.elements);
  const components = componentInventory(snapshot);
  const forms = formStateSignature(snapshot.formStructures);
  // Include the page title to distinguish SPA route changes where the URL
  // and DOM structure are identical but the title differs (e.g. tabbed
  // dashboards, wizard steps). The title is normalised using the same
  // dynamic text normaliser as visible content (#52 defect #5).
  const title = normaliseDynamicText(
    (snapshot.title || "").toLowerCase()
  ).slice(0, 60);

  const composite = `${route}|${structure}|${content}|${components}|${forms}|${title}`;
  return simpleHash(composite);
}

/**
 * Check if two state fingerprints represent the same application state.
 *
 * @param {string} fp1
 * @param {string} fp2
 * @returns {boolean}
 */
export function statesEqual(fp1, fp2) {
  return fp1 === fp2;
}
