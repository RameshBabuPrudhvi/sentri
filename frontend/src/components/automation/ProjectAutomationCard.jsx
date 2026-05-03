/**
 * ProjectAutomationCard — expandable accordion for a single project's
 * CI/CD triggers and schedule configuration.
 *
 * Redesigned from vertical stacked sections to an inner tab bar:
 *   CI/CD Tokens | Schedule
 *
 * Status chips in the collapsed header give at-a-glance config state
 * so users never need to expand a project just to see if it's configured.
 *
 * Quality Gates + Web Vitals Budgets have moved to the "Quality Gates"
 * top-level tab (ProjectQualityCard) to keep each accordion focused.
 *
 * @param {{ project, defaultExpanded?, canEdit?, onToast? }} props
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown, Globe, ExternalLink,
  Zap, Clock,
} from "lucide-react";
import TokenManager from "./TokenManager.jsx";
import ScheduleManager from "./ScheduleManager.jsx";
import { useAutomationStatusQuery } from "../../hooks/queries/useAutomationStatusQueries.js";

const INNER_TABS = [
  { id: "tokens",   label: "CI/CD Tokens", icon: Zap   },
  { id: "schedule", label: "Schedule",     icon: Clock },
];

export default function ProjectAutomationCard({
  project,
  defaultExpanded = false,
  canEdit = false,
  onToast,
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [innerTab, setInnerTab] = useState("tokens");
  const navigate = useNavigate();

  // Load status chips eagerly (on mount) so collapsed headers show info.
  // Each chip is its own query so a token mutation doesn't refetch the schedule.
  const { data: tokenCount }  = useAutomationStatusQuery(project.id, "tokens");
  const { data: hasSchedule } = useAutomationStatusQuery(project.id, "schedule");

  return (
    <div className="card auto-card">

      {/* ── Accordion header ── */}
      <button
        className="auto-card__header"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        <div className="auto-card__icon">
          <Globe size={14} color="var(--purple)" />
        </div>

        <div className="auto-card__title-block">
          <div className="auto-card__name">{project.name}</div>
          <div className="auto-card__url">{project.url}</div>
        </div>

        {/* Status chips — always visible in header */}
        <div className="auto-card__chips">
          {tokenCount !== null && (
            <span className={`auto-chip ${tokenCount > 0 ? "auto-chip--blue" : "auto-chip--gray"}`}>
              {tokenCount > 0 ? `${tokenCount} token${tokenCount !== 1 ? "s" : ""}` : "No tokens"}
            </span>
          )}
          {hasSchedule !== null && (
            <span className={`auto-chip ${hasSchedule ? "auto-chip--green" : "auto-chip--gray"}`}>
              {hasSchedule ? "Scheduled" : "No schedule"}
            </span>
          )}
        </div>

        <ChevronDown
          size={15}
          color="var(--text3)"
          className="auto-card__chevron"
          style={{ transform: expanded ? "rotate(180deg)" : "none" }}
        />
      </button>

      {/* ── Expanded body ── */}
      {expanded && (
        <div className="auto-card__expanded">

          {/* Inner tab bar */}
          <div className="auto-inner-tabs">
            {INNER_TABS.map(tab => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  className={`auto-inner-tab ${innerTab === tab.id ? "active" : ""}`}
                  onClick={() => setInnerTab(tab.id)}
                >
                  <Icon size={12} />
                  {tab.label}
                </button>
              );
            })}

            {/* View project link — pushed to right */}
            <button
              className="btn btn-ghost btn-xs auto-inner-tabs__project-link"
              onClick={e => { e.stopPropagation(); navigate(`/projects/${project.id}`); }}
            >
              View project <ExternalLink size={10} />
            </button>
          </div>

          {/* Inner tab content */}
          <div className="auto-inner-content">
            {innerTab === "tokens" && (
              <TokenManager projectId={project.id} />
            )}
            {innerTab === "schedule" && (
              <ScheduleManager projectId={project.id} />
            )}
          </div>

        </div>
      )}
    </div>
  );
}