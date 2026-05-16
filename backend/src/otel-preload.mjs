/**
 * @module otel-preload
 * @description INF-007 — OpenTelemetry + Sentry preload (NEXT.md acceptance criterion).
 *
 * OpenTelemetry auto-instrumentation (`@opentelemetry/auto-instrumentations-node`)
 * works by monkey-patching the exports of `express`, `pg`, `ioredis`, and `http`
 * at import time. If `NodeSDK.start()` runs *after* those modules have already
 * been imported, the auto-instrumentations have nothing to patch — the SDK
 * boots successfully and traces still flow for manually-instrumented spans,
 * but the framework-level HTTP / DB / Redis spans never fire.
 *
 * NEXT.md INF-007 checklist line 52 explicitly requires:
 *   "OTel SDK init must be FIRST import in `backend/src/index.js`
 *    (before Express, before DB)."
 *
 * The only correct way to satisfy that in an ESM project is to preload this
 * module via `node --import ./src/otel-preload.mjs`. Top-level `await` in this
 * file blocks the rest of the import graph from resolving until the SDK has
 * fully started, guaranteeing the monkey-patches are installed before
 * `express`, `pg`, etc. are ever evaluated.
 *
 * This module is referenced from:
 *   - `backend/package.json` scripts (`start`, `dev`, `worker`)
 *   - `backend/Dockerfile` CMD
 *   - `docker-compose.yml` worker service command
 *
 * The `test` script deliberately does NOT preload this module — tests don't
 * need OTel auto-instrumentation, and skipping it keeps the test harness
 * free of phantom spans / Sentry init noise.
 *
 * ### Safety contract
 * - `initOpenTelemetry()` is a no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset.
 * - `Sentry.init()` is a no-op when `SENTRY_DSN` is unset.
 * - Any failure during preload (e.g. OTel SDK import error in a slim container)
 *   is logged and swallowed — the application must still boot. Observability
 *   is not load-bearing for serving requests.
 *
 * Do NOT add application logic here. This module exists solely to install the
 * observability scaffolding before the application graph is constructed.
 */

import dotenv from "dotenv";
import { initOpenTelemetry } from "./utils/observability.js";

// `.env` must be loaded before reading OTEL_* / SENTRY_DSN — the preload runs
// before `index.js` calls `dotenv.config()`, so we duplicate the call here.
// `dotenv` is idempotent (the second config() in index.js is a no-op for
// vars already set).
dotenv.config();

try {
  await initOpenTelemetry();
} catch (err) {
  // Best-effort: never let an observability boot failure crash the app.
  // Logged via raw console because `utils/logFormatter` may itself import
  // modules that aren't fully resolved during the preload phase.
  // eslint-disable-next-line no-console
  console.warn(`[otel-preload] OpenTelemetry init failed: ${err?.message || err}`);
}

if (process.env.SENTRY_DSN) {
  try {
    const Sentry = await import("@sentry/node");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
      beforeSend(event) {
        // INF-007: Aggressive PII scrub on the backend Sentry payload. The
        // `event.request` block populated by `Sentry.setupExpressErrorHandler`
        // captures the entire request shape by default — headers, cookies,
        // query string, AND parsed body. For a QA platform that handles
        // credentials (`/auth/login`, `/auth/mfa/verify`, `/auth/oauth/*`),
        // OAuth tokens, and customer-supplied project secrets, ANY of those
        // fields can carry payloads we must not ship to a third-party crash
        // reporter (GDPR / SOC 2 minimum bar).
        //
        // We strip everything except the route template — that's enough to
        // group errors meaningfully without leaking payload contents. Pair
        // this with the `workspace_id` / `user_role` Sentry tags set in
        // `middleware/workspaceScope.js#attachSentryContext` to get tenant
        // attribution without PII.
        if (event.request) {
          delete event.request.headers;        // Authorization, Cookie, X-CSRF-Token
          delete event.request.cookies;        // session, refresh, token_exp
          delete event.request.data;           // POST/PUT body — passwords, TOTP, OAuth codes
          delete event.request.query_string;   // OAuth `code`, magic-link `token`, reset `t`
          delete event.request.env;            // REMOTE_ADDR / IP
        }
        // Defence in depth: the SDK can also populate top-level user-pii
        // fields from auto-instrumentation. Drop them — the only user
        // context we keep is the anonymous `id` set in `workspaceScope.js`.
        if (event.user) {
          delete event.user.email;
          delete event.user.username;
          delete event.user.ip_address;
        }
        return event;
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[otel-preload] Sentry init failed: ${err?.message || err}`);
  }
}
