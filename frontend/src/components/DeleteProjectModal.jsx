import React, { useState, useEffect } from "react";
import { RefreshCw, Trash2, AlertTriangle } from "lucide-react";
import { api } from "../api.js";

/**
 * Confirmation modal for deleting a project.
 *
 * Props:
 *   project   — project object { id, name }
 *   onClose   — called when modal should close
 *   onDeleted — called with the deleted project id after successful deletion
 */
export default function DeleteProjectModal({ project, onClose, onDeleted }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  // Close on Escape
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await api.deleteProject(project.id);
      onDeleted(project.id);
      onClose();
    } catch (err) {
      setError(err.message || "Failed to delete project.");
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-panel" style={{ width: "min(440px, 95vw)", padding: "28px 32px" }}>
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 20 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, background: "var(--red-bg)",
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <AlertTriangle size={18} color="var(--red)" />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: "1rem", marginBottom: 6 }}>
              Delete "{project.name}"?
            </div>
            <div style={{ fontSize: "0.875rem", color: "var(--text2)", lineHeight: 1.6 }}>
              This will permanently delete the project, all its tests, and all run history.
              <strong style={{ color: "var(--text)" }}> This cannot be undone.</strong>
            </div>
          </div>
        </div>

        {error && (
          <div className="alert-error" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={deleting}>
            Cancel
          </button>
          <button
            className="btn btn-sm"
            style={{ background: "var(--red)", color: "#fff", border: "none" }}
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? <RefreshCw size={13} className="spin" /> : <Trash2 size={13} />}
            {deleting ? "Deleting…" : "Delete project"}
          </button>
        </div>
      </div>
    </>
  );
}
