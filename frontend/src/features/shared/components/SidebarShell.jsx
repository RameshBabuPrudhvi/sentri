import React from "react";
import { NavLink } from "react-router-dom";
import {
  Bot, Cpu, Database, Eye, ExternalLink, KeyRound, Lock,
  Route as RouteIcon, Shield, ShieldCheck, Users, Zap,
} from "lucide-react";

/**
 * SidebarShell — presentational left-rail nav, scope-agnostic.
 *
 * Used by both:
 *   - `features/settings/SettingsSidebar.jsx` (workspace-scoped, `/settings/<key>`)
 *   - `features/project-settings/...`        (project-scoped, `/projects/:id/settings/<key>`)
 *
 * Takes data, owns no scope knowledge. Group labels, section keys, and the
 * URL base path are all caller-supplied so the same chrome can drive any
 * settings-style surface (industry pattern — GitHub, Vercel, Linear, Sentry
 * all reuse one sidebar component for workspace + project settings).
 *
 * Icons are resolved here from string names so the section config files
 * stay JSX-free (consumable by non-React code without paying the
 * lucide-react import cost).
 *
 * @param {object} props
 * @param {string} props.basePath              URL prefix for NavLinks, no trailing slash
 *                                             (e.g. "/settings", "/projects/abc/settings").
 * @param {string} [props.ariaLabel="Sections"] `aria-label` on the `<nav>`.
 * @param {Array<{
 *   key: string,
 *   label: string,
 *   sections: Array<{
 *     key: string,
 *     label: string,
 *     icon: string,           // lucide-react component name (see ICONS map below)
 *   }>
 * }>} props.groups
 */
const ICONS = {
  Zap, Route: RouteIcon, Bot, Users, Cpu, ExternalLink, Database,
  KeyRound, Shield, ShieldCheck, Eye, Lock,
};

export default function SidebarShell({ basePath, ariaLabel = "Sections", groups }) {
  return (
    <nav className="settings-sidebar" aria-label={ariaLabel}>
      {groups.map((group) => (
        <div key={group.key} className="settings-sidebar__group">
          <div className="settings-sidebar__group-label">
            {group.label}
          </div>
          {group.sections.map((section) => {
            const Icon = ICONS[section.icon] || Shield;
            return (
              <NavLink
                key={section.key}
                to={`${basePath}/${section.key}`}
                className={({ isActive }) =>
                  `settings-nav-link${isActive ? " active" : ""}`
                }
              >
                <span className="settings-nav-link__icon">
                  <Icon size={14} />
                </span>
                {section.label}
              </NavLink>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
