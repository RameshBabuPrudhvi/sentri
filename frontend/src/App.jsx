import React from "react";
import { BrowserRouter, Routes, Route, Navigate, Link } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Tests from "./pages/Tests.jsx";
import ProjectDetail from "./pages/ProjectDetail.jsx";
import NewProject from "./pages/NewProject.jsx";
import RunDetail from "./pages/RunDetail.jsx";
import TestDetail from "./pages/TestDetail.jsx";
import Settings from "./pages/Settings.jsx";
import Projects from "./pages/Applications";
import Reports from "./pages/Reports";
import Work from "./pages/Work";
import Context from "./pages/Context";

// ── 404 page ────────────────────────────────────────────────────────────────
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

// ── Global error boundary ────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "80px 40px", textAlign: "center", color: "var(--text2)", maxWidth: 500, margin: "0 auto" }}>
          <div style={{ fontSize: "2.5rem", marginBottom: 16 }}>💥</div>
          <div style={{ fontWeight: 700, fontSize: "1.2rem", color: "var(--text)", marginBottom: 8 }}>Something went wrong</div>
          <div style={{ fontSize: "0.85rem", marginBottom: 24, lineHeight: 1.6 }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload page</button>
            <button className="btn btn-ghost" onClick={() => { window.location.href = "/dashboard"; }}>Go to Dashboard</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/tests" element={<Tests />} />
            {/* /projects/new must come before /projects/:id to avoid shadowing */}
            <Route path="/projects/new" element={<NewProject />} />
            <Route path="/projects/:id" element={<ProjectDetail />} />
            <Route path="/runs/:runId" element={<RunDetail />} />
            <Route path="/tests/:testId" element={<TestDetail />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/work" element={<Work />} />
            <Route path="/context" element={<Context />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
