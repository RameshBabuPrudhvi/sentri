/**
 * @module pages/Automation
 * @description Automation hub — CI/CD triggers, scheduled runs, and
 * integration snippets across all projects. Replaces the old System page.
 *
 * Each project gets an expandable accordion card with its own token
 * management and (future) schedule config. A shared Integration Snippets
 * section at the bottom provides copy-to-clipboard CI examples.
 */

import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Zap, FolderOpen } from "lucide-react";
import { api } from "../api.js";
import usePageTitle from "../hooks/usePageTitle.js";
import ProjectAutomationCard from "../components/automation/ProjectAutomationCard.jsx";
import IntegrationSnippets from "../components/automation/IntegrationSnippets.jsx";

export default function Automation() {
  usePageTitle("Automation");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading]   = useState(true);

  // Optional ?project=PRJ-1 param to auto-expand a specific project
  const focusProjectId = searchParams.get("project");

  useEffect(() => {
    api.getProjects()
      .then(setProjects)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="page-container" style={{ maxWidth: 880 }}>
      {[60, 120, 120].map((h, i) => (
        <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 14 }} />
      ))}
    </div>
  );

  return (
    <div className="fade-in page-container" style={{ maxWidth: 880 }}>

      {/* Header */}
      <div className="mb-lg">
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Zap size={22} color="var(--accent)" />
          Automation
        </h1>
        <p className="page-subtitle" style={{ marginTop: 6 }}>
          CI/CD triggers, scheduled runs, and integrations for your projects
        </p>
      </div>

      {/* Empty state */}
      {projects.length === 0 ? (
        <div className="card" style={{ padding: 48, textAlign: "center" }}>
          <FolderOpen size={32} color="var(--text3)" style={{ marginBottom: 14 }} />
          <div style={{ fontWeight: 700, fontSize: "1rem", marginBottom: 6 }}>No projects yet</div>
          <div style={{ fontSize: "0.85rem", color: "var(--text3)", marginBottom: 20 }}>
            Create a project first, then configure CI/CD triggers and schedules here.
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => navigate("/projects/new")}>
            Create Project
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Per-project cards */}
          {projects.map((p, i) => (
            <ProjectAutomationCard
              key={p.id}
              project={p}
              defaultExpanded={focusProjectId ? p.id === focusProjectId : i === 0}
            />
          ))}

          {/* Shared integration snippets */}
          <IntegrationSnippets
            projects={projects}
            defaultProjectId={focusProjectId || projects[0]?.id}
          />
        </div>
      )}
    </div>
  );
}
