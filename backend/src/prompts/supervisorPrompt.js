export function buildSupervisorPrompt({ transcript = [], lastArtifact = null, policy = {} } = {}) {
  // Truncate heavy payloads so the supervisor prompt stays within any
  // LLM's context window. In crawl-mode the initial artifact carries
  // full `snapshotsByUrl` + `classifiedPages` (easily 0.5–2 MB for a
  // 10-page site). Without truncation the supervisor call fails with a
  // token-limit error on every real-world crawl, triggering
  // `supervisor_dispatch_error` and masking the autonomous path behind
  // the fail-OPEN linear fallback.
  const MAX_ARTIFACT_CHARS = 4000;
  const MAX_TRANSCRIPT_CHARS = 8000;

  let artifactStr = JSON.stringify(lastArtifact);
  if (artifactStr.length > MAX_ARTIFACT_CHARS) {
    artifactStr = artifactStr.slice(0, MAX_ARTIFACT_CHARS) + "…[truncated]";
  }

  const recentTranscript = transcript.slice(-10);
  let transcriptStr = JSON.stringify(recentTranscript);
  if (transcriptStr.length > MAX_TRANSCRIPT_CHARS) {
    transcriptStr = transcriptStr.slice(0, MAX_TRANSCRIPT_CHARS) + "…[truncated]";
  }

  // Return `{ system, user }` shape so `buildEffectivePrompt` in the
  // dispatcher can apply `agent_configs.systemPromptOverride` for the
  // supervisor role. Pre-fix the plain-string return silently defeated
  // per-role customization — every other agent prompt in the codebase
  // uses the structured shape.
  const system = [
    "You are Sentri supervisor agent. Decide which role should act next or terminate the thread.",
    "Return STRICT JSON only with either:",
    "{\"nextRole\":\"explorer|planner|author|oracle|reviewer\",\"instruction\":\"...\",\"rationale\":\"...\"}",
    "OR {\"terminate\":true,\"finalArtifact\":{...},\"rationale\":\"...\"}",
  ].join("\n");

  const user = [
    `Policy: ${JSON.stringify(policy)}`,
    `Last artifact: ${artifactStr}`,
    `Transcript: ${transcriptStr}`,
  ].join("\n");

  return { system, user };
}

export function normalizeSupervisorDecision(raw = {}) {
  if (raw && raw.terminate === true) return { terminate: true, finalArtifact: raw.finalArtifact ?? null, rationale: raw.rationale || null };
  const nextRole = String(raw?.nextRole || "").trim();
  if (!nextRole) return { terminate: true, finalArtifact: raw?.finalArtifact ?? null, rationale: "invalid_next_role" };
  return { terminate: false, nextRole, instruction: String(raw?.instruction || "Continue."), rationale: raw?.rationale || null };
}
