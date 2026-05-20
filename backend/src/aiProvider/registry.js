/**
 * @module aiProvider/registry
 * @description Public re-export facade for provider-state operations.
 *
 * The actual state (runtime keys, sticky fallback, circuit breakers,
 * detectProvider) currently lives in `./index.js` so callers continue to
 * import from the existing `aiProvider.js` re-export shim without change.
 * This module is the *canonical* import path for any new code that needs to
 * read or mutate provider state — `index.js` is large only because it still
 * holds the state, and future PRs can physically relocate state into this
 * file without touching consumers.
 *
 * Why a facade NOW: spec calls out registry as the state owner. Locking the
 * import surface now means AI-005 multi-agent dispatch can add per-role
 * circuit breakers here (`breakerKey(provider, role)`) without breaking any
 * caller — every caller already imports from `./registry.js`, not from the
 * monolithic `./index.js`.
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
