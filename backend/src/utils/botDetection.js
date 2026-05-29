/**
 * @module utils/botDetection
 * @description Bundle-A fix #19 — shared bot-detection patterns for the crawl
 * path AND the post-run failure classifier.
 *
 * Pre-fix two copies of the pattern list existed:
 *   - `backend/src/pipeline/feedbackLoop.js` (BOT_BLOCK failure category)
 *   - `backend/src/pipeline/stateExplorer.js#BOT_DETECTION_PATTERNS`
 *
 * They drifted: `feedbackLoop.js` carried the `\/blocked(?:[/?#]|$)`
 * boundary fix (so `/blocked-users` admin paths don't trip the gate),
 * but `stateExplorer.js` had the older `\/blocked/i` which over-matched.
 * The drift was the bug — a self-hosted app with an admin page at
 * `/blocked-users` was correctly classified by the post-run classifier
 * but mid-crawl the state explorer would still treat the same URL as a
 * bot wall and abandon the page.
 *
 * Consolidating to ONE module is the only way to keep them in lockstep.
 * Both consumers now import these exports and the behaviour is
 * byte-identical across the two surfaces.
 *
 * ### Pattern contract
 *
 * Each entry in `BOT_DETECTION_PATTERNS` is a RegExp tested against
 * either a URL (mid-crawl `page.url()`, post-run `result.url`) or, for
 * the text-keyword entries, against error-message text (`result.error`
 * + page-text snippets).
 *
 * Anchored on path boundaries (`/blocked(?:[/?#]|$)/i`) so legitimate
 * application paths nested under `/blocked-*` (e.g. `/users/blocked-list`,
 * `/admin/blocked-accounts`) are NOT misclassified. Bot-detection
 * landing pages reliably surface as the canonical exact path.
 */

/**
 * URL/text patterns that indicate bot detection, CAPTCHA, or anti-automation
 * interstitials. Used by:
 *   - `pipeline/feedbackLoop.js#classifyFailure` (BOT_BLOCK category)
 *   - `pipeline/stateExplorer.js#isSameOriginAndValid` (mid-crawl skip)
 *
 * Order matches the historical `feedbackLoop.js` priority — bot-block
 * is matched before secondary symptoms (locator timeout, navigation
 * timeout) so the root cause is reported, not the symptom.
 */
export const BOT_DETECTION_PATTERNS = Object.freeze([
  // Google's anti-bot wall (e.g. www.google.com/sorry/index)
  /\/sorry\//i,
  // Generic CAPTCHA paths
  /\/captcha/i,
  // Cloudflare / WAF challenge pages
  /\/challenge/i,
  // Path-segment-anchored canonical bot-block landing (Cloudflare et al).
  //
  // Anchored to `/blocked` followed by `/`, `?`, `#`, or end-of-string so
  // legitimate application paths nested under `/blocked-*` (e.g.
  // `/users/blocked-list`, `/admin/blocked-accounts`) are NOT misclassified.
  // The canonical anti-bot landing page is exactly `/blocked` — apps that
  // nest functionality under `/blocked-*` are a real-world false-positive
  // risk this anchor prevents.
  /\/blocked(?:[/?#]|$)/i,
  // reCAPTCHA / hCaptcha references — both as path component and as text
  // in error messages.
  /recaptcha/i,
  // Anti-automation interstitial text snippets — surface as the page's
  // visible body copy or as adjacent log lines in a failure message.
  /unusual traffic/i,
  /are you a robot/i,
  /detected unusual traffic/i,
  /verify you are human/i,
  /cloudflare.*challenge/i,
]);

/**
 * State-explorer-only extensions that classify HTTP-error landing pages
 * as terminal states. These are NOT in the post-run failure classifier
 * because a 403/429 is a legitimate API response that the test author
 * may have INTENDED to assert against — only the explorer's "is this a
 * useful page to crawl deeper into?" gate uses them.
 *
 * Also includes `accounts.google.com/v3/signin` which is the Google
 * SSO interstitial the explorer hits when crawling apps that proxy
 * OAuth through Google — followed only when login credentials are
 * configured (handled separately in the explorer's auth flow).
 */
export const EXPLORER_TERMINAL_URL_PATTERNS = Object.freeze([
  /accounts\.google\.com\/v3\/signin/i,
  /\/error\/?$/i,
  /\/403\/?$/i,
  /\/429\/?$/i,
]);

/**
 * Combined pattern list for the state explorer's mid-crawl gate.
 * Includes bot-detection PLUS the explorer-only HTTP-error patterns.
 * Wraps the two frozen arrays into one immutable frozen array — callers
 * should iterate, not mutate.
 */
export const EXPLORER_BOT_DETECTION_PATTERNS = Object.freeze([
  ...BOT_DETECTION_PATTERNS,
  ...EXPLORER_TERMINAL_URL_PATTERNS,
]);

/**
 * Test whether a URL or error-text string matches any bot-detection
 * pattern. Convenience helper that consumers can use instead of
 * iterating `BOT_DETECTION_PATTERNS.some(...)` themselves.
 *
 * @param {string} input — URL or error-message text
 * @returns {boolean} true when at least one pattern matches
 */
export function isBotDetectionUrlOrText(input) {
  if (typeof input !== "string" || input.length === 0) return false;
  return BOT_DETECTION_PATTERNS.some((re) => re.test(input));
}
