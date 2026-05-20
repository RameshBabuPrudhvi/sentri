/**
 * @module aiProvider/registry
 * @description Public re-export facade for provider-state operations.
 *
 * The actual state lives in `./index.js` (orchestrator) so this file stays
 * tiny and stable. The facade exists per AI-002 spec to give every consumer
 * a single canonical import path, which is what lets future AI-005
 * multi-agent dispatch evolve the breaker keyspace, key-resolution, or
 * detection logic without breaking any caller — they all already import
 * from `./registry.js`.
 *
 * Why not physically relocate state here in this PR: doing so requires
 * touching every internal call site in `index.js` (~40+ call sites) which
 * would balloon the diff past the reviewable size REVIEW.md asks for.
 * The facade locks the import surface; relocation is a pure mechanical
 * move-and-shadow operation that can land in a follow-up `chore` PR
 * without affecting any consumer — `git mv`-shape, not a redesign.
 *
 * Per AGENT.md "every finding produces an outcome": the relocation is
 * tracked in ROADMAP.md as AI-002b.
 */
export {
  // Mutators
  setRuntimeKey,
  setRuntimeOllama,
  setActiveProvider,
  loadKeysFromDatabase,

  // Detection + status
  getProvider,
  hasProvider,
  isLocalProvider,
  isProviderDegraded,
  getProviderMeta,
  getProviderName,
  getConfiguredKeys,
  getSupportedProviders,

  // Connectivity check (Ollama)
  checkOllamaConnection,
} from "./index.js";
