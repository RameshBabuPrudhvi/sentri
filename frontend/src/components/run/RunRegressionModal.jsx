import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Play, X, RefreshCw } from "lucide-react";
import { api } from "../api.js";
import ModalShell from "../shared/ModalShell.jsx";

/**
 * Shared modal for running regression tests for a project.
 * Replaces the duplicate RunAllModal (Tests.jsx) and RunModal (Runs.jsx).
 *
 * Props:
 *   projects        — array of project objects { id, name }
 *   onClose         — called when modal should close
 *   defaultProjectId — optional: pre-select this project
 */
export default function RunRegressionModal({ projects, onClose, defaultProjectId }) {
  const [projectId, setProjectId] = useState(defaultProjectId || projects[0]?.id || "");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  // Sync if defaultProjectId changes after mount
  useEffect(() => {
    if (defaultProjectId) setProjectId(defaultProjectId);
  }, [defaultProjectId]);

  async function handleRun() {
    if (!projectId) { setError("Please select a project."); return; }
    setError(null);
    setRunning(true);
    try {
      const { runId } = await api.runTests(projectId);
      onClose();
      navigate(`/runs/${runId}`);
    } catch (err) {
      setError(err.message || "Failed to start run.");
      setRunning(false);
    }
  }

  return (
    <ModalShell onClose={onClose} width="min(420px, 95vw)">
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "18px 22px 16px", borderBottom: "1px solid var(--border)",
      }}>
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 700, flex: 1 }}>
          Run Regression Tests
        </h2>
        <button className="modal-close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div style={{ padding: "20px 22px 24px" }}>
        <p style={{
          fontSize: "0.82rem", color: "var(--text2)",
          marginTop: 0, marginBottom: 20, lineHeight: 1.6,
        }}>
          Select a project to run all approved tests in its regression suite.
        </p>

        {projects.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <label>Project</label>
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
          </div>
        )}

        {error && (
          <div className="alert-error" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleRun}
            disabled={running || !projectId}
          >
            {running ? <RefreshCw size={13} className="spin" /> : <Play size={13} />}
            {running ? "Starting…" : "Run Tests"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
