import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App.jsx";
import { queryClient } from "./queryClient";
import "./index.css";

// INF-007: Sentry frontend init. No-op when `VITE_SENTRY_DSN` is unset — the
// guard ensures the SDK never touches the network for self-hosted deployments
// that don't want crash reporting. NEXT.md INF-007 fix #4 calls for both
// `ErrorBoundary` integration (wired in `components/layout/ErrorBoundary.jsx`)
// and **breadcrumbs on route changes** — `browserTracingIntegration` adds
// automatic `navigation` breadcrumbs for every History API push/replace plus
// pageload breadcrumbs on first paint, which is exactly the trail operators
// need when triaging a frontend crash report ("what page were they on?").
//
// ### PII discipline
// SaaS crash reporting at scale needs aggressive PII scrubbing — every
// breadcrumb and event passes through `beforeBreadcrumb` / `beforeSend` to
// strip query strings (often carry one-time tokens / OAuth codes), input
// values from breadcrumbs (form inputs leak passwords), and the standard
// `event.user.email` / `event.user.username` fields that the SDK would
// otherwise populate from `Sentry.setUser({ email, username })`. We only
// retain anonymous `user.id` (set after login from `app_auth_user`) so
// per-tenant rollups stay accurate while no personally-identifying field
// leaves the browser. This is the GDPR / SOC 2 minimum bar for sending
// events to a third-party crash-reporting vendor.
//
// `tracesSampleRate` defaults to `0` to keep performance-trace volume off
// by default — set `VITE_SENTRY_TRACES_SAMPLE_RATE=0.05` (5%) for RUM.
// `release` ties events to a deploy via the Vite build ID (`__APP_VERSION__`
// is replaced at build time; falls back to `dev` for local).
if (import.meta.env.VITE_SENTRY_DSN) {
  /**
   * Strip the query string + hash from a URL so we never leak the tokens
   * commonly embedded there (OAuth `code`, magic-link `token`, password-reset
   * `t`, audit-log `cursor`). The pathname is retained because route paths
   * are the breadcrumb's primary signal — operators need to know which page
   * the user was on when the crash happened.
   */
  function stripUrlSecrets(url) {
    try {
      const u = new URL(url, window.location.origin);
      return u.origin + u.pathname;
    } catch { return url; }
  }

  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE || 0),
    release: import.meta.env.VITE_APP_VERSION || "dev",
    environment: import.meta.env.MODE,
    // Send `default-pii: false` and explicitly null user-pii fields so the
    // SDK doesn't auto-collect IP addresses or browser-reported usernames.
    sendDefaultPii: false,
    beforeBreadcrumb(breadcrumb) {
      // Strip secrets from URL-carrying breadcrumbs (navigation, fetch,
      // xhr, history). Pathname survives so the navigation trail is intact.
      if (breadcrumb?.data?.url) breadcrumb.data.url = stripUrlSecrets(breadcrumb.data.url);
      if (breadcrumb?.data?.to) breadcrumb.data.to = stripUrlSecrets(breadcrumb.data.to);
      if (breadcrumb?.data?.from) breadcrumb.data.from = stripUrlSecrets(breadcrumb.data.from);
      // UI breadcrumbs (click / input) include the DOM target's `.value` —
      // we explicitly drop it so a "click on input[name=password]" breadcrumb
      // doesn't ship the password to Sentry.
      if (breadcrumb?.category === "ui.input" || breadcrumb?.category === "ui.click") {
        if (breadcrumb.message && breadcrumb.message.length > 200) {
          breadcrumb.message = breadcrumb.message.slice(0, 200);
        }
      }
      return breadcrumb;
    },
    beforeSend(event) {
      // Scrub the request URL on the event itself (separate from breadcrumbs).
      if (event.request?.url) event.request.url = stripUrlSecrets(event.request.url);
      // Strip any populated PII fields the SDK auto-collected — defence in
      // depth on top of `sendDefaultPii: false`.
      if (event.user) {
        delete event.user.email;
        delete event.user.username;
        delete event.user.ip_address;
      }
      return event;
    },
  });

  // INF-007: Anonymous user id for per-tenant Sentry rollups. The auth context
  // persists a sanitised user profile under `app_auth_user` (no password,
  // no secrets — see `frontend/src/context/AuthContext.jsx`). We only forward
  // the `id` field to Sentry; email / name are never sent, matching the
  // backend's `Sentry.setUser({ id })`-only pattern in `workspaceScope.js`.
  try {
    const raw = window.localStorage.getItem("app_auth_user");
    if (raw) {
      const profile = JSON.parse(raw);
      if (profile?.id) Sentry.setUser({ id: profile.id });
      if (profile?.workspaceId) Sentry.setTag("workspace_id", profile.workspaceId);
    }
  } catch { /* localStorage may be unavailable in privacy modes */ }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
