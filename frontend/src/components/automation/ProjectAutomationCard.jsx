/**
 * ProjectAutomationCard — expandable card for a single project's automation config.
 *
 * Shows CI/CD trigger token management. Future: scheduling (ENH-006),
 * notifications (ENH-017), monitoring mode (S4-06).
 *
 * @param {{ project: {id: string, name: string, url: string}, defaultExpanded?: boolean }} props
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Globe, ExternalLink, Zap, Clock } from "lucide-react";
import TokenManager from "./TokenManager.jsx";

export default function ProjectAutomationCard({ project, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const navigate = useNavigate();

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      {/* Header — clickable to expand/collapse */}
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display: "flex", alignItems: "center", gap: 12, width: "100%",
          background: "none", border: "none", cursor: "pointer",
          padding: "18px 22px", textAlign: "left",
        }}
      >
        <div style={{
          width: 32, height: 32, borderRadius: 8, background: "var(--purple-bg)",
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        }}>
          <Globe size={14} color="var(--purple)" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: "0.92rem", color: "var(--text)" }}>
            {project.name}
          </div>
          <div style={{ fontSize: "0.73rem", fontFamily: "var(--font-mono)", color: "var(--text3)", marginTop: 1 }}>
            {project.url}
          </div>
        </div>
        <ChevronDown size={15} color="var(--text3)"
          style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s", flexShrink: 0 }} />
      </button>

      {/* Expanded content */}
      {expanded && (
        <div style={{ padding: "0 22px 22px", borderTop: "1px solid var(--border)" }}>

          {/* ── CI/CD Triggers ────────────────────────────────────────── */}
          <div style={{ marginTop: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <Zap size={13} color="var(--accent)" />
              <span style={{ fontWeight: 700, fontSize: "0.88rem", color: "var(--text)" }}>CI/CD Triggers</span>
              <button
                className="btn btn-ghost btn-xs"
                style={{ marginLeft: "auto" }}
                onClick={(e) => { e.stopPropagation(); navigate(`/projects/${project.id}`); }}
              >
                View project <ExternalLink size={10} />
              </button>
            </div>
            <TokenManager projectId={project.id} />
          </div>

          {/* ── Scheduled Runs (placeholder for ENH-006) ─────────────── */}
          <div style={{ marginTop: 24, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <Clock size={13} color="var(--text3)" />
              <span style={{ fontWeight: 700, fontSize: "0.88rem", color: "var(--text)" }}>Scheduled Runs</span>
            </div>
            <div style={{
              padding: "16px 18px", background: "var(--bg2)", borderRadius: "var(--radius)",
              border: "1px dashed var(--border)", color: "var(--text3)", fontSize: "0.82rem",
              textAlign: "center",
            }}>
              Scheduled runs coming soon — configure cron-based automated regression runs.
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
