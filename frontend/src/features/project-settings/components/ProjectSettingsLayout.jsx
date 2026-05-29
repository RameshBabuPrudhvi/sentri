import React, { useCallback, useMemo } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { api } from "../../../api.js";
import usePageTitle from "../../../hooks/usePageTitle.js";
import { useToast } from "../../../context/ToastContext.jsx";
import SidebarShell from "../../shared/components/SidebarShell.jsx";
import PageSkeleton from "../../../components/layout/PageSkeleton.jsx";
import { useProjectSettingsSections } from "../hooks/useProjectSettingsSections.js";
import { ProjectSettingsContext } from "./ProjectSettingsContext.js";

/**
 * Project Settings layout shell — header + back button + sticky sidebar +
 * `<Outlet />` content area, scoped to one project.
 *
 * Mirrors `features/settings/SettingsLayout.jsx` for the workspace-scoped
 * Settings page; the difference is the sidebar's `basePath` is bound to
 * `/projects/:id/settings` and the project is hydrated via React Query so
 * every section sees the same cached object.
 *
 * Industry pattern (GitHub repo Settings / Vercel project Settings / Linear
 * project Settings) — workspace + project both use the same sidebar chrome
 * with different section sets. This file is the thin glue that binds the
 * shared `SidebarShell` to a project-scoped section registry +
 * project-scoped React Query.
 */
export default function ProjectSettingsLayout() {
  const { id: projectId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { showToast } = useToast();
  const { groups, canEdit } = useProjectSettingsSections();

  // Hydrate the project. Reuses `api.getProject` (the same endpoint the
  // Project Detail page hits at `useProjectDetailQueries.js:46`), so a user
  // navigating Project → Settings gets the cached payload immediately.
  // Query key includes the section so cross-section navigation doesn't
  // refetch — the project is the same regardless of which section is open.
  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
    enabled: !!projectId,
  });

  const project = projectQuery.data || null;

  usePageTitle(project ? `${project.name} · Settings` : "Project Settings");

  // Toast helper — sections forward this to their panel components. The
  // callable supports two argument shapes because the panel components
  // currently call it two different ways:
  //
  //   1. Object form: `onToast({ type, message })` — used by
  //      AutoApprovalPanel, CoveragePanel, IterationCapPanel, PiiFirewallPanel,
  //      VisionHealingPanel (the panels extracted directly into
  //      `features/project-settings/sections/*`).
  //
  //   2. Positional form: `onToast(message, type)` — used by
  //      `ConfigurablePanel` (`components/project/ConfigurablePanel.jsx:105`),
  //      which backs both `QualityGatesPanel` and `WebVitalsBudgetsPanel`.
  //
  // UX-001: previously this routed every panel toast into `addNotification()`
  // — i.e. the notification BELL, not a visible toast — so users saving
  // Auto-Approval / Quality Gates / Web Vitals / Coverage / Iteration Cap /
  // PII Firewall / Vision Healing in Project Settings saw no confirmation.
  // Now we forward to the global `useToast()` provider mounted in App.jsx.
  // The bell stays for durable async events (run-complete, scheduled-trigger
  // fired). Unifying the panel-side contract to a single signature would be
  // cleaner but touches 7+ files; accepting both here is the smaller-
  // blast-radius fix.
  const onToast = useCallback((msg, typeArg) => {
    if (!msg) return;
    let type;
    let message;
    if (typeof msg === "string") {
      // Positional form: onToast("Saved", "success") — `typeArg` carries
      // the level; default to "info" when absent (matches the legacy
      // `showToast` helper signature in ConfigurablePanel).
      message = msg;
      type = typeArg || "info";
    } else {
      // Object form: onToast({ type, message }) — destructure with the
      // same default. `typeArg` is ignored on the object path since the
      // object already carries the level.
      type = msg.type || "info";
      message = msg.message;
    }
    if (!message) return;
    showToast(message, type === "error" ? "error" : type === "success" ? "success" : "info");
  }, [showToast]);

  const refresh = useCallback(() => projectQuery.refetch(), [projectQuery]);

  const ctxValue = useMemo(
    () => ({ project, canEdit, onToast, refresh }),
    [project, canEdit, onToast, refresh],
  );

  // Section keys derived from the URL. Used only for the page subtitle —
  // SidebarShell handles `aria-current` highlighting via NavLink itself.
  const pathSegments = location.pathname.split("/").filter(Boolean);
  // /projects/:id/settings/<section>
  const activeSectionKey = pathSegments[3] || null;

  if (projectQuery.isLoading) {
    return (
      <div className="fade-in page-container-xl">
        <PageSkeleton />
      </div>
    );
  }

  if (projectQuery.isError || !project) {
    return (
      <div className="fade-in page-container-xl">
        <button className="btn btn-ghost btn-sm settings-back" onClick={() => navigate(-1)}>
          <ArrowLeft size={14} /> Back
        </button>
        <div className="settings-header">
          <h1 className="settings-header__title">Project not found</h1>
          <p className="settings-header__sub">
            This project may have been deleted, or you may not have access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in page-container-xl">
      <button
        className="btn btn-ghost btn-sm settings-back"
        onClick={() => navigate(`/projects/${project.id}`)}
      >
        <ArrowLeft size={14} /> Back to project
      </button>

      <div className="settings-header">
        <h1 className="settings-header__title">{project.name}</h1>
        <p className="settings-header__sub">
          Project settings — quality gates, review workflow, security, and self-healing.
        </p>
      </div>

      <div className="settings-shell">
        <SidebarShell
          basePath={`/projects/${project.id}/settings`}
          ariaLabel="Project settings sections"
          groups={groups}
        />
        <div className="settings-main">
          <ProjectSettingsContext.Provider value={ctxValue}>
            <Outlet key={activeSectionKey} />
          </ProjectSettingsContext.Provider>
        </div>
      </div>
    </div>
  );
}
