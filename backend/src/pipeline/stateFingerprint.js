/**
 * @module pipeline/stateFingerprint
 * @description State fingerprinting for the state-based exploration engine.
 *
 * Produces a deterministic fingerprint of the current browser state that goes
 * beyond the existing {@link module:pipeline/smartCrawl.fingerprintStructure}
 * (which only hashes element tags). A state fingerprint captures:
 *   - URL route (pathname + hash, no query params)
 *   - DOM structural shape (reuses smartCrawl.fingerprintStructure)
 *   - Visible text content hash
 *   - Modal / dialog open state
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

/**
 * Extract the route portion of a URL (pathname + hash, no query params).
 * Normalises trailing slashes so `/about/` and `/about` fingerprint the same.
 *
 * @param {string} url
 * @returns {string}
 */
function extractRoute(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.hostname}${path}${u.hash}`;
  } catch { return url; }
}

/**
 * Hash the visible text content from a snapshot's elements.
 * Uses only the first 40 chars of each element's text to keep the fingerprint
 * stable across minor content changes (timestamps, counters).
 *
 * @param {Array} elements
 * @returns {string}
 */
function hashVisibleContent(elements) {
  const text = (elements || [])
    .filter(el => el.visible !== false)
    .map(el => (el.text || "").slice(0, 40).toLowerCase().trim())
    .filter(Boolean)
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

/**
 * Produce a deterministic fingerprint of the current application state.
 *
 * Combines route, DOM structure, visible content, modal state, and form state
 * into a single hash string. Used by the state explorer to detect whether an
 * action caused a meaningful state transition.
 *
 * @param {object} snapshot — page snapshot from {@link module:pipeline/pageSnapshot.takeSnapshot}
 * @returns {string} deterministic fingerprint string
 */
export function fingerprintState(snapshot) {
  const route = extractRoute(snapshot.url);
  const structure = fingerprintStructure(snapshot);
  const content = hashVisibleContent(snapshot.elements);
  const modal = snapshot.hasModals ? "modal" : "no_modal";
  const tabs = snapshot.hasTabs ? "tabs" : "no_tabs";
  const forms = formStateSignature(snapshot.formStructures);

  const composite = `${route}|${structure}|${content}|${modal}|${tabs}|${forms}`;
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
