import React, { useState, useEffect } from "react";
import { RefreshCw, Trash2, AlertTriangle } from "lucide-react";
import { api } from "../../api.js";
import { invalidateProjectDataCache } from "../../hooks/useProjectData.js";
import ModalShell from "./ModalShell.jsx";

/**
 * Confirmation modal for deleting a project.
 *
 * Checks for CI/CD tokens and schedules that will be permanently destroyed
 * (not recoverable via restore) and warns the user before proceeding.
 *
 * Props:
 *   project   — project object { id, name }
 *   onClose   — called when modal should close
 *   onDeleted — called with the deleted project id after successful deletion
 */
export default function DeleteProjectModal({ project, onClose, onDeleted }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  // Check for automation config that will be permanently destroyed on delete.
  // Tokens and schedules are hard-deleted (not soft-deleted) because they are
  // security credentials / active cron tasks.  Restoring the project from the
  // recycle bin will NOT bring them back.
  const [tokenCount, setTokenCount] = useState(0);
  const [hasSchedule, setHasSchedule] = useState(false);

  useEffect(() => {
    if (!project?.id) return;
    api.getTriggerTokens(project.id)
      .then(tokens => setTokenCount(tokens.length))
      .catch(() => {});
    api.getSchedule(project.id)
      .then(data => setHasSchedule(!!(data.schedule && data.schedule.enabled)))
      .catch(() => {});
  }, [project?.id]);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await api.deleteProject(project.id);
      // Bust the shared cache so Dashboard, Tests, Runs pages don't show
      // the deleted project for the remainder of the 30-second TTL.
      invalidateProjectDataCache();
      onDeleted(project.id);
      onClose();
    } catch (err) {
      setError(err.message || "Failed to delete project.");
      setDeleting(false);
    }
  }

  const hasAutomation = tokenCount > 0 || hasSchedule;

  return (
    <ModalShell onClose={onClose} style={{ padding: "28px 32px" }}>
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
            This will move the project, all its tests, and all run history to the recycle bin.
          </div>
        </div>
      </div>

      {/* Warn about permanently destroyed automation config */}
      {hasAutomation && (
        <div className="banner banner-warning" style={{ marginBottom: 16, fontSize: "0.83rem", lineHeight: 1.6 }}>
          <strong>⚠️ Permanent automation loss:</strong> The following will be{" "}
          <strong>permanently deleted</strong> and cannot be restored even if the project is recovered:
          <ul style={{ margin: "6px 0 0 1.2em", padding: 0 }}>
            {tokenCount > 0 && (
              <li>{tokenCount} CI/CD trigger token{tokenCount !== 1 ? "s" : ""} — pipelines using them will break immediately</li>
            )}
            {hasSchedule && (
              <li>Active cron schedule — scheduled runs will stop</li>
            )}
          </ul>
        </div>
      )}

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
    </ModalShell>
  );
}
