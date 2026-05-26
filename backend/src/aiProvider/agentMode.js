/**
 * @module aiProvider/agentMode
 * @description Env-driven agent orchestration mode switch (AUTO-023 Bundle 2).
 *
 * Reads `SENTRI_AGENT_MODE` from the environment and exposes:
 *
 *   - `getAgentMode()` — returns the validated mode string, defaulting to
 *     `"pipeline"` when unset or invalid.
 *   - `isEnvelopeReadEnabled()` — gate used by `agentHandoff.readLatestEnvelope`
 *     to short-circuit reads in the default (`pipeline`) mode while still
 *     allowing writes (B2.4 dual-write shim contract).
 *
 * Valid modes: `pipeline` (default, today's behaviour), `envelope` (read+write
 * envelopes at stage boundaries, linear DAG unchanged), `autonomous` (reserved
 * for Bundle 3+ supervisor orchestration).
 */

const MODES = new Set(["pipeline", "envelope", "autonomous"]);

/**
 * Resolve the current agent orchestration mode from the environment.
 *
 * Parses `process.env.SENTRI_AGENT_MODE` (case-insensitive, whitespace-trimmed)
 * and validates it against the closed-set of supported modes. Falls back to
 * `"pipeline"` when the env var is unset, empty, or contains an unrecognised
 * value — defence-in-depth so a typo can't silently enable envelope reads.
 *
 * @returns {"pipeline"|"envelope"|"autonomous"} The validated mode.
 */
export function getAgentMode() {
  const mode = String(process.env.SENTRI_AGENT_MODE || "pipeline").trim().toLowerCase();
  return MODES.has(mode) ? mode : "pipeline";
}

/**
 * Whether the envelope read path is active.
 *
 * In `pipeline` mode reads are gated off (writes still fire as an audit
 * trail — see B2.4 shim contract). In `envelope` and `autonomous` modes
 * reads resolve against `agent_messages` so each stage actually consumes
 * the upstream envelope.
 *
 * @returns {boolean} `true` iff `getAgentMode() !== "pipeline"`.
 */
export function isEnvelopeReadEnabled() {
  return getAgentMode() !== "pipeline";
}
