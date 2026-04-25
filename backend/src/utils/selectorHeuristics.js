/**
 * @module utils/selectorHeuristics
 * @description Shared selector-shape heuristics used by self-healing
 * transforms and validator checks to avoid drift.
 */

/**
 * Best-effort check for CSS/XPath-like selector strings.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function looksLikeCssSelector(value) {
  if (!value || typeof value !== "string") return false;
  const s = value.trim();
  return /^[#.\[/]|^\/\//.test(s)
    || /(?:[\w\])])\s[>~+]\s(?:[\w#.\[:])/.test(s)
    || /\w\[[^\]]+\]/.test(s)
    || /:(?:nth-child|nth-of-type|first-child|last-child|has|is|not)\(/.test(s);
}

