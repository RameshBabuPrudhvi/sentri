/**
 * pipelineAdapter.js — AUTO-022 generation adapters
 *
 * The scorer in `pipelineEval.js` is pure: it never calls the LLM. This
 * module supplies the `generate(golden) → string` callback that produces
 * the `actual` Playwright code for the scorer to compare against
 * `golden.expected`.
 *
 * Two adapters:
 *   - createLiveAdapter()    — calls the real production pipeline
 *                              (`generateAllTests` → `runPostGenerationPipeline`)
 *                              and writes the result to a cache file.
 *                              Used in dev with `EVAL_RECORD=1`.
 *   - createReplayAdapter()  — reads from the cache only. Used in CI.
 *                              Hard-fails if a cache entry is missing so
 *                              missing recordings can't silently pass.
 *
 * Cache key = sha256(promptVersion + snapshot + url) → keeps replays
 * stable when goldens change but invalidates them automatically when the
 * prompt template version bumps.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
// Bumped manually whenever a prompt template change is intentional.
// Changing this invalidates every cache entry → forces a record pass.
export const PROMPT_VERSION = "1";

/**
 * Identifier for the LLM model the cache was recorded against. Defaults to
 * the env var that the production provider abstraction reads, with a
 * sentinel fallback so cache keys stay stable when the var is unset (e.g.
 * in unit tests that never call the live adapter). Folded into the cache
 * key so swapping models invalidates every entry — otherwise a quiet model
 * swap could ship green against stale recordings.
 *
 * @type {string}
 */
export const EVAL_MODEL = process.env.EVAL_MODEL || process.env.AI_MODEL || "default";

function cacheKey(golden) {
  const h = crypto.createHash("sha256");
  h.update(PROMPT_VERSION);
  h.update("\0");
  h.update(EVAL_MODEL);
  h.update("\0");
  h.update(String(golden.id ?? ""));
  h.update("\0");
  h.update(String(golden.snapshot ?? ""));
  h.update("\0");
  h.update(String(golden.url ?? ""));
  return h.digest("hex").slice(0, 32);
}
function cachePath(cacheDir, golden) {
  return path.join(cacheDir, `${golden.id}.${cacheKey(golden)}.txt`);
}
/**
 * Build the replay adapter. Reads pre-recorded responses from `cacheDir`.
 * Throws on cache miss — CI must never silently score against a stub.
 *
 * Note: `run-eval.mjs` short-circuits BEFORE invoking the replay adapter
 * when the harness is in cold-start state (empty cache + placeholder
 * baseline). This adapter's strict throw-on-miss contract is preserved so
 * that once any recordings exist, an accidentally-missing one fails loudly
 * rather than silently scoring 0. See `isBootstrapState` in run-eval.mjs.
 */
export function createReplayAdapter({ cacheDir }) {
  return async function generate(golden) {
    const file = cachePath(cacheDir, golden);
    if (!fs.existsSync(file)) {
      throw new Error(
        `eval cache miss for ${golden.id} (key ${cacheKey(golden)}). ` +
        `Re-run with EVAL_RECORD=1 to populate the cache, or bump PROMPT_VERSION.`
      );
    }
    return fs.readFileSync(file, "utf8");
  };
}
/**
 * Build the live adapter. Calls the production pipeline and writes the
 * generated Playwright code to the cache for future replays.
 *
 * The injection of `pipeline` keeps this file unit-testable and avoids
 * dragging the entire backend graph into CI when only the scorer runs.
 */
export function createLiveAdapter({ cacheDir, pipeline }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  return async function generate(golden) {
    const code = await pipeline.generate(golden);
    fs.writeFileSync(cachePath(cacheDir, golden), code, "utf8");
    return code;
  };
}
/**
 * Default production pipeline binding. Lazily imports the real modules so
 * the scorer can be unit-tested without pulling in Playwright / DB / LLM
 * SDKs. Returns a `{ generate(golden) }` shape consumable by
 * createLiveAdapter().
 *
 * The classifiedPage / journey shapes mirror what `crawler.js` builds at
 * `backend/src/crawler.js:616` — see journeyGenerator.js for the contract.
 */
export async function createDefaultPipeline() {
  const { generateAllTests } = await import("../pipeline/journeyGenerator.js");
  const { runPostGenerationPipeline } = await import("../pipeline/pipelineOrchestrator.js");
  return {
    async generate(golden) {
      const url = golden.url || "https://eval.local/";
      const snapshot = { title: golden.id, html: golden.snapshot, elements: [] };
      const classifiedPage = {
        url,
        isHighPriority: true,
        dominantIntent: "FORM",
      };
      const journey = { name: golden.id, pages: [{ url }] };
      const onProgress = () => {};
      const { tests = [] } = await generateAllTests(
        [classifiedPage],
        [journey],
        { [url]: snapshot },
        onProgress,
        { dialsPrompt: "", testCount: "one" },
      );
      // Minimal project / run stubs — orchestrator only reads ids + url.
      const project = { id: `eval-${golden.id}`, url };
      const run = { id: `eval-${golden.id}-run`, projectId: project.id, log: [] };
      const result = await runPostGenerationPipeline(tests, project, run, {
        snapshotsByUrl: { [url]: snapshot },
        classifiedPagesByUrl: { [url]: classifiedPage },
      });
      const finalTests = result?.tests ?? tests;
      return finalTests
        .map((t) => (Array.isArray(t.steps) ? t.steps.join("\n") : (t.code || "")))
        .filter(Boolean)
        .join("\n");
    },
  };
}
