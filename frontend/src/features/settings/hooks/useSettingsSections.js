import { useMemo } from "react";
import { useAuth } from "../../../context/AuthContext.jsx";

/**
 * Settings section registry — single source of truth (GAP-002).
 *
 * Each entry drives one route under `/settings/<key>` and one row in the
 * SettingsSidebar. Group labels mirror the industry-standard sidebar
 * layout used by GitHub Settings / Vercel / Linear / Sentry — admin
 * surfaces live under "Workspace", per-user surfaces under "Account".
 *
 * `adminOnly` is the UI gate; backend routes still enforce role via
 * `requireRole()`. Non-admins see the section hidden from the sidebar
 * AND the route renders `<AdminLockedSection />` if reached by URL.
 *
 * Icons are imported lazily by SettingsSidebar to keep this module pure
 * (no JSX) so it can be consumed by non-React code without paying the
 * lucide-react import cost.
 */
export const SETTINGS_SECTIONS = [
  // ── Workspace group (admin surfaces — AI / org / data) ─────────────────
  //
  // ai_providers merges the old "Providers" (family key cards) and
  // "Provider Routes" (named route CRUD) into one coherent surface.
  // The mental model: each configured model = one AI Provider = one
  // selectable agent. The old `providers` and `provider_routes` keys are
  // intentionally omitted from the visible nav — they still mount via
  // routes.jsx for deep-link compat (MfaGraceBanner, onboarding wizard
  // emitTourEvent, export/import bookmarks) but operators land on the
  // new ai_providers section by default.
  { key: "ai_providers",   label: "AI Providers",   icon: "Cpu",          adminOnly: true,  group: "workspace" },
  { key: "agent_roles",    label: "Agent Roles",    icon: "Bot",          adminOnly: true,  group: "workspace" },
  // UX-AUDIT (May 2026): Members is VISIBLE to every workspace member but
  // mutations (invite / role-change / remove) are gated to admin inside
  // `MembersSection.jsx`. Industry standard — GitHub, Linear, Vercel, Mabl,
  // Testim, and Datadog Synthetic all show the member roster to every
  // authenticated member. Hiding it is suspicious and breaks the social
  // contract of "who else is in my workspace?". Backend still enforces
  // admin-only on mutation routes via `requireRole()`.
  { key: "members",        label: "Members",        icon: "Users",        adminOnly: false, group: "workspace" },
  { key: "data",           label: "Data",           icon: "Database",     adminOnly: true,  group: "workspace" },

  // ── Account group (visible to every member) ─────────────────────────────
  // `execution` is read-only runtime info — anyone can view.
  { key: "execution",      label: "Execution",      icon: "Cpu",          adminOnly: false, group: "account" },
  // Integrations is gated by qa_lead on the backend (GET /settings/github-checks).
  // Keep it under "account" so viewers see it for read-only visibility; the
  // backend rejects mutations from below qa_lead.
  { key: "integrations",   label: "Integrations",   icon: "ExternalLink", adminOnly: false, group: "account" },
  // SEC-004: per-user MFA / passkey management. Every member manages their
  // own factors; the admin-only enforcement panel is gated inside the section.
  { key: "security",       label: "Security",       icon: "KeyRound",     adminOnly: false, group: "account" },
  { key: "account",        label: "Account",        icon: "Shield",       adminOnly: false, group: "account" },
];

/**
 * Returns role-filtered sections grouped for the sidebar. Memoised on
 * `workspaceRole` so the sidebar only re-renders when the user's role
 * actually changes (e.g. cross-workspace switch).
 *
 * Shape:
 *   { sections: [{key, label, icon, adminOnly, group}],
 *     groups:   [{key: "workspace", label: "Workspace", sections: [...]},
 *                {key: "account",   label: "Account",   sections: [...]}],
 *     fallback: <first visible section key for redirects> }
 */
export function useSettingsSections() {
  const { user } = useAuth();
  const isAdmin = user?.workspaceRole === "admin";

  return useMemo(() => {
    const visible = SETTINGS_SECTIONS.filter((s) => isAdmin || !s.adminOnly);
    const groups = [
      { key: "workspace", label: "Workspace", sections: visible.filter((s) => s.group === "workspace") },
      { key: "account",   label: "Account",   sections: visible.filter((s) => s.group === "account") },
    ].filter((g) => g.sections.length > 0);
    return {
      sections: visible,
      groups,
      // Fallback section for `/settings` (no segment) → first visible. Admins
      // land on `ai_providers`; viewers / qa_leads land on `execution` (first
      // non-admin entry — never a 403-prone surface).
      fallback: visible[0]?.key || "account",
      isAdmin,
    };
  }, [isAdmin]);
}
