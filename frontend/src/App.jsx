import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Projects from "./pages/Projects.jsx";
import ProjectDetail from "./pages/ProjectDetail.jsx";
import NewProject from "./pages/NewProject.jsx";
import RunDetail from "./pages/RunDetail.jsx";
import Settings from "./pages/Settings.jsx";

// Stub pages
const Stub = ({ title }) => (
  <div style={{ padding: "60px 0", textAlign: "center", color: "var(--text2)" }}>
    <div style={{ fontSize: "2rem", marginBottom: 12 }}>🚧</div>
    <div style={{ fontWeight: 600, fontSize: "1.1rem", marginBottom: 6 }}>{title}</div>
    <div style={{ fontSize: "0.875rem" }}>Coming soon</div>
  </div>
);

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/new" element={<NewProject />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="/runs/:runId" element={<RunDetail />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/reports"  element={<Stub title="Reports" />} />
          <Route path="/work"     element={<Stub title="Work" />} />
          <Route path="/context"  element={<Stub title="Context" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
