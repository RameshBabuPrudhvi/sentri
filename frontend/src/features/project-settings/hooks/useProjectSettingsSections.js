import { useMemo } from "react";
import { useAuth } from "../../../context/AuthContext.jsx";
import { userHasRole } from "../../../utils/roles.js";

/**
 * Project-settings section registry — single source of truth for the
 * project-scoped left rail at `/projects/:id/settings/<key>`.
 *
 * Mirrors `features/settings/hooks/useSettingsSections.js` but for
 * project-scoped configuration. Each entry drives one route and one
 * sidebar row. Industry pattern (GitHub repo Settings / Vercel project
 * Settings / Linear project Settings) — workspace + project both use
 * the same sidebar chrome with different section sets.
 *
 * Section regrouping rationale (May 2026 audit):
 *   The legacy "Quality Gates" tab on `/automation` had 7 inner tabs
 *   that conflated three different concerns — pass/fail gates (Gates,
 *   Web Vitals, Coverage), review workflow (Auto-Approval), execution
 *   config (Iterations), security (PII Firewall), and self-healing
 *   (Vision Healing). Splitting them into themed sections makes the
 *   page name match its contents and aligns with how every mature tool
 *   surfaces project-scoped configuration.
 *
 * Role gates:
 *   `mutateRole` is the role required to save changes in a section.
 *   Viewers see the section read-only (each panel disables its inputs
 *   when `canEdit === false`). The backend enforces `requireRole()` on
 *   every mutation route as defence-in-depth.
 *
 * Icons are plain strings here so this module stays JSX-free —
 * `SidebarShell` resolves them to lucide-react components.
 */
export const PROJECT_SETTINGS_SECTIONS = [
  // ── Quality group — pass/fail signals on a run ─────────────────────────
  {
    key: "quality-gates",
    label: "Quality Gates",
    icon: "ShieldCheck",
    group: "quality",
    mutateRole: "qa_lead",
  },

  // ── Workflow group — review + execution knobs ──────────────────────────
  {
    key: "review",
    label: "Review",
    icon: "Bot",
    group: "workflow",
    mutateRole: "qa_lead",
  },
  {
    key: "execution",
    label: "Execution",
    icon: "Database",
    group: "workflow",
    mutateRole: "qa_lead",
  },

  // ── Platform group — security + self-healing ───────────────────────────
  {
    key: "security",
    label: "Security",
    icon: "Lock",
    group: "platform",
    mutateRole: "qa_lead",
  },
  {
    key: "self-healing",
    label: "Self-Healing",
    icon: "Eye",
    group: "platform",
    mutateRole: "qa_lead",
  },
];

const GROUP_LABELS = {
  quality:  "Quality",
  workflow: "Workflow",
  platform: "Platform",
};

/**
 * Returns the section registry projected for the current user. Memoised on
 * the user's role so the sidebar only re-renders when role actually changes.
 *
 * Shape:
 *   { sections, groups, fallback, canEdit }
 *
 *   - `sections` — every section (no role-based filtering; viewers see
 *     read-only rather than hidden, matching the workspace Settings
 *     "Members" pattern).
 *   - `groups`   — same sections grouped for the sidebar with `label`s
 *     resolved from `GROUP_LABELS`.
 *   - `fallback` — first section key, used by the index-route redirect.
 *   - `canEdit`  — convenience boolean for the layout to thread through
 *     React context to every panel (qa_lead+ on the workspace).
 */
export function useProjectSettingsSections() {
  const { user } = useAuth();
  const canEdit = userHasRole(user, "qa_lead");

  return useMemo(() => {
    const visible = PROJECT_SETTINGS_SECTIONS;
    const groups = [
      { key: "quality",  label: GROUP_LABELS.quality,  sections: visible.filter((s) => s.group === "quality")  },
      { key: "workflow", label: GROUP_LABELS.workflow, sections: visible.filter((s) => s.group === "workflow") },
      { key: "platform", label: GROUP_LABELS.platform, sections: visible.filter((s) => s.group === "platform") },
    ].filter((g) => g.sections.length > 0);
    return {
      sections: visible,
      groups,
      fallback: visible[0]?.key || "quality-gates",
      canEdit,
    };
  }, [canEdit]);
}
