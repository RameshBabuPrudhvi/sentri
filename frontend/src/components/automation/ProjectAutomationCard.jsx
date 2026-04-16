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
import ScheduleManager from "./ScheduleManager.jsx";

export default function ProjectAutomationCard({ project, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const navigate = useNavigate();

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      {/* Header — clickable to expand/collapse */}
      <button className="auto-card__header" onClick={() => setExpanded(e => !e)}>
        <div className="auto-card__icon">
          <Globe size={14} color="var(--purple)" />
        </div>
        <div className="flex-1">
          <div className="font-bold" style={{ fontSize: "0.92rem" }}>
            {project.name}
          </div>
          <div className="text-xs text-mono text-muted" style={{ marginTop: 1 }}>
            {project.url}
          </div>
        </div>
        <ChevronDown size={15} color="var(--text3)" className="shrink-0"
          style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="auto-card__body">

          {/* ── CI/CD Triggers ────────────────────────────────────────── */}
          <div className="auto-card__section">
            <div className="auto-card__section-title">
              <Zap size={13} color="var(--accent)" />
              <span>CI/CD Triggers</span>
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

          {/* ── Scheduled Runs (ENH-006) ──────────────────────────────── */}
          <div className="auto-card__section--bordered">
            <div className="auto-card__section-title">
              <Clock size={13} color="var(--accent)" />
              <span>Scheduled Runs</span>
            </div>
            <ScheduleManager projectId={project.id} />
          </div>

        </div>
      )}
    </div>
  );
}
