/**
 * @module utils/envScope
 * @description DIF-012 — Single source of truth for the
 * "env-scoped project" shape used by every execution entry point that
 * accepts an optional `environmentId` override.
 *
 * Replaces four copy-pasted local helpers that previously lived in
 * `routes/runs.js`, `routes/tests.js`, `routes/trigger.js`, and
 * `workers/runWorker.js`. Consolidating them here means any future change
 * to the credential-override rule, the `canonicalUrl` stamp, or the
 * preview-URL precedence happens in exactly one place — drift between
 * the four entry points caused real bugs during DIF-012 development.
 *
 * ### Contract
 * - `environment === null` → returns `project` unchanged (zero-regression
 *   for projects without environments).
 * - `previewUrl` (Vercel/Netlify webhook path) takes precedence over
 *   `environment.baseUrl`, matching the existing AUTO-015 deploy-preview
 *   behaviour.
 * - `environment.credentials` is already in the same encrypted shape as
 *   `project.credentials` — `routes/projects.js` encrypts on POST/PATCH
 *   and the env repo only JSON-parses on read (see `rowToEnv` in
 *   `environmentRepo.js`). Assign verbatim — re-encrypting would
 *   double-encrypt and silently break login. Falls back to
 *   `project.credentials` when the env has no credentials of its own.
 * - `canonicalUrl` preserves the original production URL so the
 *   AUTO-015 baseline guard in `crawler.js` treats this as a
 *   preview-style crawl and doesn't overwrite production fingerprints.
 * - The project row in the DB is NEVER mutated; this returns a
 *   shallow-cloned scoped copy used only for the lifetime of one run.
 *
 * @param {Object} project - Persisted project row (credentials encrypted).
 * @param {Object|null} [environment] - Optional env row from
 *   `environmentRepo.getById()`. `undefined` is treated the same as
 *   `null` (e.g. when the worker looks up an env that was deleted
 *   between enqueue and pickup).
 * @param {Object} [opts]
 * @param {string|null} [opts.previewUrl] - Optional deploy-preview URL
 *   override that wins over `environment.baseUrl`.
 * @returns {Object} the scoped project.
 */
export function envScopedProject(project, environment, { previewUrl = null } = {}) {
  if (!environment && !previewUrl) return project;
  const url = previewUrl || environment?.baseUrl || project.url;
  let credentials = project.credentials;
  if (environment?.credentials && (environment.credentials.username || environment.credentials.password)) {
    credentials = environment.credentials;
  }
  return { ...project, url, credentials, canonicalUrl: project.url };
}
