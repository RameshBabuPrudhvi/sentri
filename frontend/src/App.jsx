import React, { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate, Link } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext.jsx";
import { NotificationProvider } from "./context/NotificationContext.jsx";
import { ThemeProvider } from "./context/ThemeContext.jsx";
import ProtectedRoute from "./components/layout/ProtectedRoute.jsx";
import Layout from "./components/layout/Layout.jsx";
import ErrorBoundary from "./components/layout/ErrorBoundary.jsx";
import PageSkeleton from "./components/layout/PageSkeleton.jsx";
import { settingsRoutes } from "./features/settings/routes.jsx";
import { projectSettingsRoutes } from "./features/project-settings/routes.jsx";

const Login = lazy(() => import("./pages/Login.jsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.jsx"));
const Tests = lazy(() => import("./pages/Tests.jsx"));
const ProjectDetail = lazy(() => import("./pages/ProjectDetail.jsx"));
const NewProject = lazy(() => import("./pages/NewProject.jsx"));
const RunDetail = lazy(() => import("./pages/RunDetail.jsx"));
const TestDetail = lazy(() => import("./pages/TestDetail.jsx"));
// GAP-002 (audit): Settings is now a feature-folder under
// `features/settings/` with a sidebar-driven shell + per-section lazy
// chunks. The old `pages/Settings.jsx` god-file has been deleted — all 9
// sections are physically extracted under `features/settings/sections/`.
// `<SettingsLayout>` parent route + `settingsRoutes` child collection own
// the URL contract; App.jsx never needs to change for new sections.
const SettingsLayout = lazy(() => import("./features/settings/SettingsLayout.jsx"));
// Project Settings — feature-folder mirror of the workspace Settings layout,
// scoped to one project at `/projects/:id/settings/*`. Same sidebar chrome
// (`SidebarShell`), same per-section lazy chunks, same `<Outlet />` pattern.
// Replaces the per-project accordion-of-tabs that previously lived inside
// `pages/Automation.jsx → ProjectQualityCard`'s "Quality Gates" sub-tab.
const ProjectSettingsLayout = lazy(() => import("./features/project-settings/components/ProjectSettingsLayout.jsx"));
const Projects = lazy(() => import("./pages/Projects.jsx"));
const Reports = lazy(() => import("./pages/Reports.jsx"));
const Runs = lazy(() => import("./pages/Runs.jsx"));
const Systems = lazy(() => import("./pages/Systems.jsx"));
const Automation = lazy(() => import("./pages/Automation.jsx"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword.jsx"));
const ChatHistory = lazy(() => import("./pages/ChatHistory.jsx"));
const TestLab       = lazy(() => import("./pages/TestLab.jsx"));
const ReviewQueue   = lazy(() => import("./pages/ReviewQueue.jsx"));
const HealingDashboard = lazy(() => import("./pages/HealingDashboard.jsx"));
const ApprovalsTimeline = lazy(() => import("./pages/ApprovalsTimeline.jsx"));
const AuditLog          = lazy(() => import("./pages/AuditLog.jsx"));

// DS-001 (audit): the inline-style block was migrated to the shared
// `.empty-state*` primitives in `frontend/src/styles/components.css` plus
// the existing `.btn .btn-primary` for the CTA. The link inherits the
// global `:focus-visible` ring through `.btn` and the `.empty-state-actions`
// row keeps it centred without per-element layout overrides.
const NotFound = () => (
  <div className="empty-state">
    <div className="empty-state-icon">404</div>
    <div className="empty-state-title">Page not found</div>
    <div className="empty-state-desc">
      The page you&rsquo;re looking for doesn&rsquo;t exist or was moved.
    </div>
    <div className="empty-state-actions">
      <Link to="/dashboard" className="btn btn-primary btn-sm">
        Go to Dashboard
      </Link>
    </div>
  </div>
);


export default function App() {
  return (
    <ThemeProvider>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <NotificationProvider>
        <ErrorBoundary>
          <Suspense fallback={<PageSkeleton />}>
            <Routes>
              {/* Public */}
              <Route path="/login" element={<Login />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />

              {/* Protected — wrapped in Layout */}
              <Route element={
                <ProtectedRoute>
                  <Layout />
                </ProtectedRoute>
              }>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/projects" element={<Projects />} />
                <Route path="/tests" element={<Tests />} />
                <Route path="/projects/new" element={<NewProject />} />
                <Route path="/projects/:id" element={<ProjectDetail />} />
                {/* Per-project settings shell — mirrors the workspace
                    Settings layout (`/settings/*`) at project scope. Lazy
                    section chunks declared inside `projectSettingsRoutes`
                    (`features/project-settings/routes.jsx`); ProjectSettingsLayout
                    hydrates the project and provides it via React context so
                    each section is a thin pass-through to its panel
                    component. Industry pattern — GitHub `repo/settings`,
                    Vercel project settings, Linear project settings. */}
                <Route path="/projects/:id/settings" element={<ProjectSettingsLayout />}>
                  {projectSettingsRoutes}
                </Route>
                <Route path="/runs/:runId" element={<RunDetail />} />
                <Route path="/tests/:testId" element={<TestDetail />} />
                {/* GAP-002 (audit): Settings shell + per-section lazy children.
                    `/settings` → `SettingsLayout` (sidebar + header + Outlet); each
                    `/settings/:section` route is defined under `settingsRoutes` and
                    renders inside the Outlet as its own lazy chunk. Industry-standard
                    layout adopted by GitHub Settings / Vercel / Linear / Sentry.
                    Legacy `/settings?tab=<key>` deep links keep working — SettingsLayout
                    redirects them to the canonical URL on mount. */}
                <Route path="/settings" element={<SettingsLayout />}>
                  {settingsRoutes}
                </Route>
                {/* SEC-007: compliance audit log — admin-gated at the route
                    layer (defence-in-depth; backend also enforces admin
                    via requireRole). Mounted at `/audit-log` only — the
                    `/settings/compliance` alias was removed to avoid two
                    paths to the same surface (which would split the
                    meta-audit trail and confuse access logs). */}
                <Route path="/audit-log" element={<ProtectedRoute requiredRole="admin"><AuditLog /></ProtectedRoute>} />
                <Route path="/reports" element={<Reports />} />
                <Route path="/runs" element={<Runs />} />
                <Route path="/system" element={<Systems />} />
                <Route path="/automation" element={<Automation />} />
                <Route path="/chat" element={<ChatHistory />} />
                <Route path="/test-lab" element={<TestLab />} />
                <Route path="/review-queue" element={<ReviewQueue />} />
                <Route path="/healing" element={<HealingDashboard />} />
                <Route path="/approvals" element={<ApprovalsTimeline />} />
                <Route path="/projects/:id/test-lab" element={<TestLab />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </Suspense>
        </ErrorBoundary>
        </NotificationProvider>
      </AuthProvider>
    </BrowserRouter>
    </ThemeProvider>
  );
}