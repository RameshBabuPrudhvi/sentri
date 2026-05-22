import React from "react";
import { NavLink } from "react-router-dom";
import {
  Bot, Cpu, Database, ExternalLink, KeyRound, Route as RouteIcon, Shield, Users, Zap,
} from "lucide-react";
import { useSettingsSections } from "./hooks/useSettingsSections.js";

/**
 * Settings sidebar — vertical left rail with grouped `<NavLink>`s per section.
 * Industry pattern adopted by GitHub Settings / Vercel / Linear / Sentry —
 * grouped semantically (Workspace vs Account), keyboard-accessible via
 * React Router's `NavLink` (gets `aria-current="page"` for free), with WCAG
 * 2.4.7 focus-visible ring from the global rule in components.css.
 */

// Icon lookup — the section config in `useSettingsSections.js` carries icon
// names as plain strings to keep that module JSX-free. Resolve to lucide
// components here.
const ICONS = {
  Zap, Route: RouteIcon, Bot, Users, Cpu, ExternalLink, Database, KeyRound, Shield,
};

const GROUP_LABELS = {
  workspace: "Workspace",
  account: "Account",
};

export default function SettingsSidebar() {
  const { groups } = useSettingsSections();

  return (
    <nav className="settings-sidebar" aria-label="Settings sections">
      {groups.map((group) => (
        <div key={group.key} className="settings-sidebar__group">
          <div className="settings-sidebar__group-label">
            {GROUP_LABELS[group.key] || group.label}
          </div>
          {group.sections.map((section) => {
            const Icon = ICONS[section.icon] || Shield;
            return (
              <NavLink
                key={section.key}
                to={`/settings/${section.key}`}
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
