import React, { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate, Link } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext.jsx";
import { NotificationProvider } from "./context/NotificationContext.jsx";
import { ThemeProvider } from "./context/ThemeContext.jsx";
import ProtectedRoute from "./components/layout/ProtectedRoute.jsx";
import Layout from "./components/layout/Layout.jsx";
import ErrorBoundary from "./components/layout/ErrorBoundary.jsx";

const Login = lazy(() => import("./pages/Login.jsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.jsx"));
const Tests = lazy(() => import("./pages/Tests.jsx"));
const ProjectDetail = lazy(() => import("./pages/ProjectDetail.jsx"));
const NewProject = lazy(() => import("./pages/NewProject.jsx"));
const RunDetail = lazy(() => import("./pages/RunDetail.jsx"));
const TestDetail = lazy(() => import("./pages/TestDetail.jsx"));
const Settings = lazy(() => import("./pages/Settings.jsx"));
const Projects = lazy(() => import("./pages/Projects.jsx"));
const Reports = lazy(() => import("./pages/Reports.jsx"));
const Runs = lazy(() => import("./pages/Runs.jsx"));
const Systems = lazy(() => import("./pages/Systems.jsx"));
const ChatHistory = lazy(() => import("./pages/ChatHistory.jsx"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword.jsx"));

const RouteLoading = () => (
  <div style={{ padding: "80px 0", textAlign: "center", color: "var(--text2)" }}>
    Loading…
  </div>
);

const NotFound = () => (
  <div style={{ padding: "80px 0", textAlign: "center", color: "var(--text2)" }}>
    <div style={{ fontSize: "3rem", marginBottom: 16 }}>404</div>
    <div style={{ fontWeight: 700, fontSize: "1.2rem", color: "var(--text)", marginBottom: 8 }}>Page not found</div>
    <div style={{ fontSize: "0.875rem", marginBottom: 24 }}>The page you're looking for doesn't exist or was moved.</div>
    <Link to="/dashboard" style={{ padding: "8px 20px", background: "var(--accent)", color: "#fff", borderRadius: "var(--radius)", fontWeight: 500, fontSize: "0.875rem", textDecoration: "none" }}>
      Go to Dashboard
    </Link>
  </div>
);


export default function App() {
  return (
    <ThemeProvider>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <NotificationProvider>
        <ErrorBoundary>
          <Suspense fallback={<RouteLoading />}>
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
                <Route path="/runs/:runId" element={<RunDetail />} />
                <Route path="/tests/:testId" element={<TestDetail />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/reports" element={<Reports />} />
                <Route path="/runs" element={<Runs />} />
                <Route path="/system" element={<Systems />} />
                <Route path="/chat" element={<ChatHistory />} />
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
