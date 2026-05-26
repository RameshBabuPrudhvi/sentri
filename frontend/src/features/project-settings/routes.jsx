import React, { lazy, Suspense } from "react";
import { Navigate, Route, useLocation, useParams } from "react-router-dom";
import PageSkeleton from "../../components/layout/PageSkeleton.jsx";
import {
  useProjectSettingsSections,
  PROJECT_SETTINGS_SECTIONS,
} from "./hooks/useProjectSettingsSections.js";

/**
 * Index-route redirect for `/projects/:id/settings`. Mirrors the workspace
 * `SettingsIndexRedirect` pattern at `features/settings/routes.jsx:24` —
 * synchronous on first paint so there's no empty-Outlet flash.
 *
 * Bare `/projects/:id/settings` → first section ("quality-gates"),
 * preserving sibling query params if any caller threads them through.
 */
function ProjectSettingsIndexRedirect() {
  const { id } = useParams();
  const { fallback } = useProjectSettingsSections();
  const location = useLocation();
  const qs = location.search;
  return <Navigate to={`/projects/${id}/settings/${fallback}${qs}`} replace />;
}

/**
 * Project-settings child routes. Each section is a lazy chunk so the
 * project-detail bundle only ships the section the user navigated to —
 * mirrors the workspace Settings decomposition from GAP-002.
 *
 * Each section file is a thin wrapper that reads `useProjectSettings()`
 * (project + canEdit + onToast + refresh) and renders the existing panel
 * components — no panel internals change as part of this restructure.
 */
const QualityGatesSection = lazy(() => import("./sections/quality-gates/QualityGatesSection.jsx"));
const ReviewSection       = lazy(() => import("./sections/review/ReviewSection.jsx"));
const ExecutionSection    = lazy(() => import("./sections/execution/ExecutionSection.jsx"));
const SecuritySection     = lazy(() => import("./sections/security/SecuritySection.jsx"));
const SelfHealingSection  = lazy(() => import("./sections/self-healing/SelfHealingSection.jsx"));

function withSuspense(Component) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Component />
    </Suspense>
  );
}

/**
 * Child route definitions for the Project Settings parent route in App.jsx.
 * Renders inside `ProjectSettingsLayout`'s `<Outlet />`. The index route
 * delegates to `ProjectSettingsIndexRedirect` so the fallback section is
 * always defined — synchronous redirect on first paint, no empty-Outlet flash.
 *
 * Section keys are kebab-case (URL-friendly) and match the registry in
 * `useProjectSettingsSections.js`. To add a new section: add an entry to
 * `PROJECT_SETTINGS_SECTIONS`, create the section file, and add a `<Route>`
 * here. The layout never needs to change.
 */
export const projectSettingsRoutes = (
  <>
    <Route index element={<ProjectSettingsIndexRedirect />} />
    <Route path="quality-gates" element={withSuspense(QualityGatesSection)} />
    <Route path="review"        element={withSuspense(ReviewSection)} />
    <Route path="execution"     element={withSuspense(ExecutionSection)} />
    <Route path="security"      element={withSuspense(SecuritySection)} />
    <Route path="self-healing"  element={withSuspense(SelfHealingSection)} />
  </>
);

// Re-export for any caller that needs the registry directly (deep-link
// validation, breadcrumbs, sitemap generation).
export { PROJECT_SETTINGS_SECTIONS };
