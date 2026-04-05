import React from "react";
import { BrowserRouter, Routes, Route, Navigate, Link } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Tests from "./pages/Tests.jsx";
import ProjectDetail from "./pages/ProjectDetail.jsx";
import NewProject from "./pages/NewProject.jsx";
import RunDetail from "./pages/RunDetail.jsx";
import TestDetail from "./pages/TestDetail.jsx";
import Settings from "./pages/Settings.jsx";
import Projects from "./pages/Applications.jsx";
import Reports from "./pages/Reports.jsx";
import Runs from "./pages/Runs.jsx";
import Context from "./pages/Context.jsx";

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
            <button className="btn btn-ghost" onClick={() => { window.location.href = import.meta.env.BASE_URL + "dashboard"; }}>Go to Dashboard</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <ErrorBoundary>
          <Routes>
            {/* Public */}
            <Route path="/login" element={<Login />} />

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
              <Route path="/context" element={<Context />} />
              <Route path="/applications" element={<Navigate to="/projects" replace />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </ErrorBoundary>
      </AuthProvider>
    </BrowserRouter>
  );
}
