import React, { useMemo } from "react";
import SidebarShell from "../shared/components/SidebarShell.jsx";
import { useSettingsSections } from "./hooks/useSettingsSections.js";

/**
 * Settings sidebar — vertical left rail with grouped `<NavLink>`s per section.
 * Industry pattern adopted by GitHub Settings / Vercel / Linear / Sentry —
 * grouped semantically (Workspace vs Account), keyboard-accessible via
 * React Router's `NavLink` (gets `aria-current="page"` for free), with WCAG
 * 2.4.7 focus-visible ring from the global rule in components.css.
 *
 * Thin wrapper around the presentational `SidebarShell` so the same chrome
 * is reused by project-scoped settings (`/projects/:id/settings/...`).
 * This file owns the workspace-scope concerns: group-label mapping +
 * `basePath` binding. The shell stays scope-agnostic.
 */
const GROUP_LABELS = {
  workspace: "Workspace",
  account: "Account",
};

export default function SettingsSidebar() {
  const { groups } = useSettingsSections();

  // Project the section-registry groups onto the shell's contract — fold the
  // GROUP_LABELS lookup into a `label` field so the shell renders headings
  // verbatim. Memoised on `groups` so a non-role render doesn't re-allocate.
  const labelledGroups = useMemo(
    () => groups.map((g) => ({ ...g, label: GROUP_LABELS[g.key] || g.label })),
    [groups],
  );

  return (
    <SidebarShell
      basePath="/settings"
      ariaLabel="Settings sections"
      groups={labelledGroups}
    />
  );
}
