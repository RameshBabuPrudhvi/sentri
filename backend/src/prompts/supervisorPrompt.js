export function buildSupervisorPrompt({ transcript = [], lastArtifact = null, policy = {} } = {}) {
  return [
    "You are Sentri supervisor agent. Decide which role should act next or terminate the thread.",
    "Return STRICT JSON only with either:",
    "{\"nextRole\":\"explorer|planner|author|oracle|reviewer|healer|triager\",\"instruction\":\"...\",\"rationale\":\"...\"}",
    "OR {\"terminate\":true,\"finalArtifact\":{...},\"rationale\":\"...\"}",
    `Policy: ${JSON.stringify(policy)}`,
    `Last artifact: ${JSON.stringify(lastArtifact)}`,
    `Transcript: ${JSON.stringify(transcript.slice(-40))}`,
  ].join("\n");
}

export function normalizeSupervisorDecision(raw = {}) {
  if (raw && raw.terminate === true) return { terminate: true, finalArtifact: raw.finalArtifact ?? null, rationale: raw.rationale || null };
  const nextRole = String(raw?.nextRole || "").trim();
  if (!nextRole) return { terminate: true, finalArtifact: raw?.finalArtifact ?? null, rationale: "invalid_next_role" };
  return { terminate: false, nextRole, instruction: String(raw?.instruction || "Continue."), rationale: raw?.rationale || null };
}
