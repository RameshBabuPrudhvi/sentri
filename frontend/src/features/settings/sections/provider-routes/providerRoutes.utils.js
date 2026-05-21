/**
 * Provider Routes pure helpers (GAP-002). Extracted verbatim from the legacy
 * Settings.jsx. No React, no DOM, no network — safe to import from any
 * provider-route sub-component or test.
 */

/** "—" / "••••<lastFour>" — masked API key display. */
export function maskedKeyDisplay(lastFour) {
  if (!lastFour) return "—";
  return `••••${lastFour}`;
}

/**
 * B3.2 — Client-side fallback-cycle preview. Walks the `fallbackRouteId`
 * chain starting from the proposed fallback and returns the offending route id
 * when the walk revisits `startRouteId` (or hits the 64-hop depth cap).
 * Mirrors `providerRouteRepo.wouldCreateCycle` so the UI matches the
 * authoritative backend check; the backend still wins on save.
 *
 * @param {Array<{id: string, fallbackRouteId?: string|null}>} rows
 * @param {string|null} startRouteId  null for create form (no self-loop possible)
 * @param {string|null} proposedFallbackId
 * @returns {string|null} routeId where the chain loops, or null
 */
export function detectFallbackCycle(rows, startRouteId, proposedFallbackId) {
  if (!proposedFallbackId) return null;
  if (startRouteId && proposedFallbackId === startRouteId) return startRouteId;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set();
  if (startRouteId) seen.add(startRouteId);
  let cur = proposedFallbackId;
  for (let i = 0; i < 64 && cur; i += 1) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    cur = byId.get(cur)?.fallbackRouteId || null;
  }
  return null;
}

/**
 * B2.5 — Replay button is disabled when the row's `promptRedacted` is null
 * (mode was `"none"` at capture) or contains a `[REDACTED_*]` sentinel
 * (mode was `"redacted"`). The backend would reject the replay with HTTP 400
 * anyway; disabling here saves the round-trip and surfaces the reason inline.
 */
export function isPromptReplayable(promptRedacted) {
  if (!promptRedacted) return false;
  if (/\[REDACTED_(EMAIL|PHONE|SSN|CARD|CUSTOM)\]/.test(promptRedacted)) return false;
  return true;
}
