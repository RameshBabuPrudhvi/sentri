/**
 * @module pages/Automation
 * @description Automation hub — CI/CD triggers, scheduled runs, quality gates,
 * integrations, and snippets across all projects.
 *
 * Layout: four top-level tabs separate concerns so users never scroll past
 * empty sections to reach what they need:
 *
 *   Triggers & Schedules — per-project CI/CD tokens + cron schedule
 *   Quality Gates         — pass-rate / failure / flaky gates + Web Vitals budgets
 *   Integrations          — integration card grid (GitHub Actions, GitLab, cURL…)
 *   Snippets              — copy-to-clipboard CI YAML/bash with project picker
 *
 * Each project renders inside its own accordion within the relevant tab.
 */

import React, { useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Zap, FolderOpen, ShieldCheck, Plug, Code2,
} from "lucide-react";
import useProjectData from "../hooks/useProjectData.js";
import usePageTitle from "../hooks/usePageTitle.js";
import { useAuth } from "../context/AuthContext.jsx";
import { userHasRole } from "../utils/roles.js";
import { useNotifications } from "../context/NotificationContext.jsx";
import ProjectAutomationCard from "../components/automation/ProjectAutomationCard.jsx";
import ProjectQualityCard from "../components/automation/ProjectQualityCard.jsx";
import IntegrationCards from "../components/automation/IntegrationCards.jsx";
import IntegrationSnippets from "../components/automation/IntegrationSnippets.jsx";
import { isValidPageTab } from "../utils/automationStatus.js";

const PAGE_TABS = [
  { id: "triggers",     label: "Triggers & Schedules", icon: Zap,         emptyHint: "Create a project first, then configure CI/CD triggers and schedules here." },
  { id: "quality",      label: "Quality Gates",        icon: ShieldCheck, emptyHint: "Create a project first, then configure quality gates and Web Vitals budgets here." },
  { id: "integrations", label: "Integrations",         icon: Plug                                                                                                  },
  { id: "snippets",     label: "Snippets",             icon: Code2                                                                                                 },
];

function EmptyProjects({ navigate, hint }) {
  return (
    <div className="card" style={{ padding: 48, textAlign: "center" }}>
      <FolderOpen size={32} color="var(--text3)" style={{ marginBottom: 14 }} />
      <div style={{ fontWeight: 700, fontSize: "1rem", marginBottom: 6 }}>No projects yet</div>
      <div style={{ fontSize: "0.85rem", color: "var(--text3)", marginBottom: 20 }}>
        {hint}
      </div>
      <button className="btn btn-primary btn-sm" onClick={() => navigate("/projects/new")}>
        Create Project
      </button>
    </div>
  );
}

export default function Automation() {
  usePageTitle("Automation");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { projects, loading } = useProjectData({ fetchTests: false, fetchRuns: false });
  const { user: authUser } = useAuth();
  const canEdit = userHasRole(authUser, "qa_lead");
  const { addNotification } = useNotifications();

  const onPanelToast = useCallback((msg, type = "info") => {
    addNotification({
      type: type === "error" ? "error" : type === "success" ? "success" : "info",
      title: msg,
    });
  }, [addNotification]);

  const focusProjectId = searchParams.get("project");

  // Active top-level tab — sourced from `?tab=...` so deep-links and Back/Forward
  // both work. `isValidPageTab` rejects unknown ids (whitelist enforced in
  // `frontend/src/utils/automationStatus.js`) so a malformed URL falls back to
  // the default "triggers" tab instead of rendering nothing.
  const tabParam = searchParams.get("tab");
  const activeTab = isValidPageTab(tabParam) ? tabParam : "triggers";

  const setActiveTab = useCallback((id) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      // Default tab is implicit — keep the URL clean by omitting `?tab=triggers`.
      if (id === "triggers") next.delete("tab");
      else next.set("tab", id);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  if (loading) return (
    <div className="page-container" style={{ maxWidth: 900 }}>
      <div className="skeleton" style={{ height: 48, borderRadius: 10, marginBottom: 20 }} />
      {[80, 120, 120].map((h, i) => (
        <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 14 }} />
      ))}
    </div>
  );

  return (
    <div className="fade-in page-container" style={{ maxWidth: 900 }}>

      {/* ── Page header ── */}
      <div className="auto-page-header">
        <h1 className="auto-page-title">
          <Zap size={20} color="var(--accent)" />
          Automation
        </h1>
        <p className="auto-page-subtitle">
          CI/CD triggers, scheduled runs, and integrations for your projects
        </p>

        {/* Top-level tab bar — WAI-ARIA tabs pattern with arrow-key navigation */}
        <div className="auto-page-tabs" role="tablist" aria-label="Automation sections">
          {PAGE_TABS.map((tab, idx) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                id={`auto-tab-${tab.id}`}
                role="tab"
                aria-selected={isActive}
                aria-controls={`auto-tabpanel-${tab.id}`}
                tabIndex={isActive ? 0 : -1}
                className={`auto-page-tab ${isActive ? "active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
                  e.preventDefault();
                  let nextIdx = idx;
                  if (e.key === "ArrowRight") nextIdx = (idx + 1) % PAGE_TABS.length;
                  else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + PAGE_TABS.length) % PAGE_TABS.length;
                  else if (e.key === "Home") nextIdx = 0;
                  else if (e.key === "End") nextIdx = PAGE_TABS.length - 1;
                  setActiveTab(PAGE_TABS[nextIdx].id);
                  document.getElementById(`auto-tab-${PAGE_TABS[nextIdx].id}`)?.focus();
                }}
              >
                <Icon size={13} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/*
        All four tabpanels are rendered up-front with the `hidden` attribute
        so their `aria-controls` targets always resolve (strict WAI-ARIA tabs
        compliance). Inactive panels still don't *do* work — heavy children
        are mounted lazily inside each branch below.
      */}

      {/* ── Tab: Triggers & Schedules ── */}
      <div
        className="auto-tab-body"
        role="tabpanel"
        id="auto-tabpanel-triggers"
        aria-labelledby="auto-tab-triggers"
        hidden={activeTab !== "triggers"}
      >
        {activeTab === "triggers" && (
          projects.length === 0
            ? <EmptyProjects navigate={navigate} hint={PAGE_TABS[0].emptyHint} />
            : projects.map((p, i) => (
                <ProjectAutomationCard
                  key={p.id}
                  project={p}
                  defaultExpanded={focusProjectId ? p.id === focusProjectId : i === 0}
                  canEdit={canEdit}
                  onToast={onPanelToast}
                />
              ))
        )}
      </div>

      {/* ── Tab: Quality Gates ── */}
      <div
        className="auto-tab-body"
        role="tabpanel"
        id="auto-tabpanel-quality"
        aria-labelledby="auto-tab-quality"
        hidden={activeTab !== "quality"}
      >
        {activeTab === "quality" && (
          projects.length === 0
            ? <EmptyProjects navigate={navigate} hint={PAGE_TABS[1].emptyHint} />
            : projects.map((p, i) => (
                <ProjectQualityCard
                  key={p.id}
                  project={p}
                  defaultExpanded={focusProjectId ? p.id === focusProjectId : i === 0}
                  canEdit={canEdit}
                  onToast={onPanelToast}
                />
              ))
        )}
      </div>

      {/* ── Tab: Integrations ── */}
      <div
        className="auto-tab-body"
        role="tabpanel"
        id="auto-tabpanel-integrations"
        aria-labelledby="auto-tab-integrations"
        hidden={activeTab !== "integrations"}
      >
        {activeTab === "integrations" && (
          <IntegrationCards onScrollToSnippets={() => setActiveTab("snippets")} />
        )}
      </div>

      {/* ── Tab: Snippets ── */}
      <div
        className="auto-tab-body"
        role="tabpanel"
        id="auto-tabpanel-snippets"
        aria-labelledby="auto-tab-snippets"
        hidden={activeTab !== "snippets"}
      >
        {activeTab === "snippets" && (
          <IntegrationSnippets
            projects={projects}
            defaultProjectId={focusProjectId || projects[0]?.id}
          />
        )}
      </div>
    </div>
  );
}