import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X, RefreshCw, Clock } from "lucide-react";
import { api } from "../api.js";
import ModalShell from "./ModalShell.jsx";
import ExploreModePicker from "./ExploreModePicker.jsx";
import { loadSavedConfig } from "../utils/testDialsStorage.js";

/**
 * Modal for crawling a project from the Tests page.
 * Lets the user pick a project, choose explore mode (link crawl vs state
 * exploration), tune explorer settings, and start a crawl + AI generation run.
 *
 * Props:
 *   projects        — array of project objects { id, name, url }
 *   onClose         — called when modal should close
 *   defaultProjectId — optional: pre-select this project
 */
export default function CrawlProjectModal({ projects, onClose, defaultProjectId }) {
  const [projectId, setProjectId] = useState(defaultProjectId || projects[0]?.id || "");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [dialsConfig, setDialsConfig] = useState(() => loadSavedConfig());
  const navigate = useNavigate();

  // Sync if defaultProjectId changes after mount
  useEffect(() => {
    if (defaultProjectId) setProjectId(defaultProjectId);
  }, [defaultProjectId]);

  const selectedProject = projects.find(p => p.id === projectId);

  async function handleCrawl() {
    if (!projectId) { setError("Please select a project."); return; }
    setError(null);
    setRunning(true);
    try {
      // Pre-flight: check if an AI provider is configured
      const config = await api.getConfig().catch(() => null);
      if (!config?.hasProvider) {
        setError("No AI provider configured — go to Settings to add an API key or enable Ollama.");
        setRunning(false);
        return;
      }
      const { runId } = await api.crawl(projectId, { dialsConfig });
      onClose();
      navigate(`/runs/${runId}`);
    } catch (err) {
      setError(err.message || "Failed to start crawl.");
      setRunning(false);
    }
  }

  return (
    <ModalShell onClose={onClose} width="min(480px, 96vw)">
      {/* Header — pinned */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "18px 22px 16px", borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}>
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 700, flex: 1 }}>
          Crawl & Generate Tests
        </h2>
        <button className="modal-close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      {/* Scrollable body */}
      <div style={{ overflowY: "auto", flex: 1, minHeight: 0, padding: "20px 22px 4px" }}>
        <p style={{
          fontSize: "0.82rem", color: "var(--text2)",
          marginTop: 0, marginBottom: 20, lineHeight: 1.6,
        }}>
          Select a project and discovery mode, then start crawling. New tests will appear as Draft for your review.
        </p>

        {projects.length === 0 ? (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <div style={{ fontSize: "0.82rem", color: "var(--text3)", marginBottom: 16 }}>
              No projects yet. Create a project first.
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => { onClose(); navigate("/projects/new"); }}>
              Create Project
            </button>
          </div>
        ) : (
          <>
            {/* Project selector */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", marginBottom: 5, fontSize: "0.82rem", fontWeight: 500, color: "var(--text2)" }}>
                Project
              </label>
              <select
                className="input"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                style={{ height: 38 }}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {selectedProject?.url && (
                <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 4, fontFamily: "var(--font-mono)" }}>
                  {selectedProject.url}
                </div>
              )}
            </div>

            <ExploreModePicker value={dialsConfig} onChange={setDialsConfig} />

            {error && (
              <div className="alert-error" style={{ marginBottom: 16 }}>
                {error}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer — pinned at bottom */}
      {projects.length > 0 && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 22px 18px", borderTop: "1px solid var(--border)", flexShrink: 0,
        }}>
          <span style={{ fontSize: "0.72rem", color: "var(--text3)", display: "flex", alignItems: "center", gap: 4 }}>
            <Clock size={11} /> ~1-3 minutes depending on site size
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleCrawl}
              disabled={running || !projectId}
            >
              {running ? <RefreshCw size={13} className="spin" /> : <Search size={13} />}
              {running ? "Starting…" : "Crawl & Generate"}
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}
