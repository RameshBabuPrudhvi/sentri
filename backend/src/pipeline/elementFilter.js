/**
 * elementFilter.js — Layer 1: Filter page elements to only keep meaningful ones
 *
 * Removes: footer links, social icons, ads, hidden elements, duplicates
 * Keeps:   forms, meaningful buttons, nav, inputs, interactive components
 */

// ── Keywords that signal meaningful intent ────────────────────────────────────

const HIGH_VALUE_BUTTON_KEYWORDS = [
  "login", "log in", "sign in", "signin",
  "register", "sign up", "signup", "create account",
  "submit", "continue", "next", "proceed",
  "buy", "purchase", "checkout", "add to cart", "order",
  "search", "find", "go",
  "save", "update", "apply", "confirm",
  "delete", "remove", "cancel",
  "download", "export", "upload",
  "send", "post", "publish",
  "get started", "try", "start",
];

const NOISE_KEYWORDS = [
  "facebook", "twitter", "instagram", "linkedin", "youtube", "tiktok",
  "pinterest", "reddit", "github", "discord",
  "©", "copyright", "privacy policy", "terms of service", "cookie",
  "advertis", "sponsor", "promo",
  "back to top", "scroll to top",
  "share", "tweet", "like",
];

const NOISE_HREFS = [
  "/cdn-cgi/", "javascript:void", "#top", "mailto:", "tel:",
  "facebook.com", "twitter.com", "instagram.com", "linkedin.com",
  "youtube.com", "tiktok.com", "t.co",
];

// ── Scoring ───────────────────────────────────────────────────────────────────

function scoreElement(el) {
  const text = el.text.toLowerCase();
  const href = el.href.toLowerCase();
  const tag = el.tag;
  const type = el.type.toLowerCase();

  // ALWAYS keep form inputs first — before any noise checks
  // A password field should never be filtered even if text is empty
  if (tag === "form") return 100;
  if (tag === "input" && ["text", "email", "password", "search", "tel", "number", ""].includes(type)) return 90;
  if (tag === "textarea") return 80;
  if (tag === "select") return 75;

  // Zero score for obvious noise (checked AFTER inputs so we never lose form fields)
  if (NOISE_KEYWORDS.some(k => text.includes(k))) return 0;
  if (NOISE_HREFS.some(k => href.includes(k))) return 0;
  if (tag === "a" && href === "") return 0;

  // High-value buttons
  if ((tag === "button" || el.role === "button") && HIGH_VALUE_BUTTON_KEYWORDS.some(k => text.includes(k))) return 95;

  // Navigation (but not footer noise)
  if (tag === "a" && text.length > 1 && text.length < 40 && !href.startsWith("http")) return 50;

  // Generic button/link — medium value
  if (tag === "button" && text.length > 1) return 60;
  if (tag === "a" && text.length > 1 && text.length < 30) return 40;

  return 10;
}

/**
 * filterElements(elements) → filtered elements with intent hints
 *
 * @param {Array} elements - raw elements from DOM snapshot
 * @returns {Array} filtered, deduplicated, scored elements
 */
export function filterElements(elements) {
  const seen = new Set();
  const scored = [];

  for (const el of elements) {
    const score = scoreElement(el);
    if (score === 0) continue;

    // Deduplicate by tag + type + text combo (include type so email != password)
    const key = `${el.tag}:${el.type}:${el.text.toLowerCase().trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    scored.push({ ...el, _score: score });
  }

  // Sort by score descending, cap at 30 elements
  return scored
    .sort((a, b) => b._score - a._score)
    .slice(0, 30);
}

/**
 * hasHighValueElements(elements) → boolean
 * Returns true if the filtered set contains elements worth testing
 */
export function hasHighValueElements(filtered) {
  return filtered.some(el => el._score >= 50);
}

/**
 * filterStats(original, filtered) → summary string for logging
 */
export function filterStats(original, filtered) {
  return `${filtered.length}/${original.length} elements kept (${original.length - filtered.length} noise removed)`;
}
