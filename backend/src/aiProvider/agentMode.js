const MODES = new Set(["pipeline", "envelope", "autonomous"]);

export function getAgentMode() {
  const mode = String(process.env.SENTRI_AGENT_MODE || "pipeline").trim().toLowerCase();
  return MODES.has(mode) ? mode : "pipeline";
}

export function isEnvelopeReadEnabled() {
  return getAgentMode() !== "pipeline";
}
