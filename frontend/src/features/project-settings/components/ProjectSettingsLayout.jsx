import React, { useCallback, useMemo } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { api } from "../../../api.js";
import usePageTitle from "../../../hooks/usePageTitle.js";
import { useNotifications } from "../../../context/NotificationContext.jsx";
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
  const { addNotification } = useNotifications();
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

  // Toast helper — sections forward this to their panel components, which
  // already expect `onToast({ type, message })` shaped calls (see
  // `QualityGatesPanel`, `AutoApprovalPanel`, etc.).
  const onToast = useCallback((msg) => {
    if (!msg) return;
    const { type = "info", message } = typeof msg === "string" ? { message: msg } : msg;
    addNotification({
      type: type === "error" ? "error" : type === "success" ? "success" : "info",
      title: message,
    });
  }, [addNotification]);

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
