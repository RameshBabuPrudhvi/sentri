import React, { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Brain, ChevronDown, AlertTriangle, Check, RefreshCw, Settings, CircleSlash, Layers } from "lucide-react";
import { api } from "../../api.js";

// ── Module-level cache ────────────────────────────────────────────────────────
// `_configCache` keeps `GET /config` for the active-provider name + hasProvider
// gate. `_routesCache` keeps `GET /settings/ai-providers` — the list of every
// `provider_routes` row in the workspace, which is the canonical "switch
// target" set per the multi-route routing model (Phase 1 of the route-based
// switcher rollout). `_groupsCache` keeps `GET /settings/route-groups` — B4.6
// route groups surfaced read-only (Phase 2). `_settingsCache` is intentionally
// retained so the legacy env-only Ollama detection path keeps working until
// every workspace has migrated to row-based dispatch.
let _configCache   = null;
let _routesCache   = null;
let _groupsCache   = null;
let _settingsCache = null;

export function invalidateConfigCache() {
  _configCache   = null;
  _routesCache   = null;
  _groupsCache   = null;
  _settingsCache = null;
}

// ── Per-family visual styles (colors only — labels come from the backend) ─────
// Keyed by `provider_routes.family`, NOT by the legacy "active provider id"
// enum. The active route's family selects the badge color; per-route names
// come from `route.displayLabel` (server-computed in `toDisplayRoute`).
const FAMILY_STYLES = {
  anthropic:  { bg: "#fef3e2", border: "#fcd8a8", color: "#b45309", dot: "#d97706", activeBg: "rgba(180,83,9,0.08)" },
  openai:     { bg: "#dcfce7", border: "#bbf7d0", color: "#15803d", dot: "#16a34a", activeBg: "rgba(21,128,61,0.08)" },
  google:     { bg: "#dbeafe", border: "#bfdbfe", color: "#1d4ed8", dot: "#2563eb", activeBg: "rgba(29,78,216,0.08)" },
  openrouter: { bg: "#eef2ff", border: "#c7d2fe", color: "#4338ca", dot: "#6466f1", activeBg: "rgba(67,56,202,0.08)" },
  local:      { bg: "#f5f3ff", border: "#ddd6fe", color: "#6d28d9", dot: "#7c3aed", activeBg: "rgba(109,40,217,0.08)" },
  custom:     { bg: "#f1f5f9", border: "#cbd5e1", color: "#475569", dot: "#64748b", activeBg: "rgba(71,85,105,0.08)" },
};

// Deterministic palette so a `custom`-family route (or any unmapped family)
// gets a stable, distinct chip color instead of falling back to grey. Hash
// the route id so two custom routes don't share the same colour.
const CUSTOM_PALETTE = ["#cd7f32", "#10a37f", "#4285f4", "#6466f1", "#0ea5e9", "#ec4899"];
function paletteStyle(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const c = CUSTOM_PALETTE[h % CUSTOM_PALETTE.length];
  return { color: c, dot: c, bg: `${c}11`, border: `${c}44`, activeBg: `${c}14` };
}

// Resolve the colour swatch for a route. Prefer the family-keyed style when
// recognised; fall back to a deterministic palette colour keyed on route id.
function styleForRoute(route) {
  if (!route) return FAMILY_STYLES.custom;
  return FAMILY_STYLES[route.family] || paletteStyle(route.id || route.family || "?");
}

// `route.capabilities` is the JSON column populated by the probe system. The
// ProbeBadge logic (`features/settings/.../ProbeBadge.jsx`) treats a route as
// healthy only when every dimension is positively true AND there's no
// `errorReason`. We mirror that gate here so the dropdown's per-row status
// dot matches what the operator sees on the Settings page — no divergence
// between "green in dropdown" and "red in Settings".
function routeHealth(route) {
  const caps = route?.capabilities;
  if (!caps) return "unknown";   // never probed yet
  if (caps.reachable === true
      && caps.auth === true
      && caps.model === true
      && !caps.errorReason) return "healthy";
  return "unhealthy";
}

export default function ProviderBadge({ style }) {
  const [config,   setConfig]   = useState(_configCache);
  const [routes,   setRoutes]   = useState(_routesCache);
  const [groups,   setGroups]   = useState(_groupsCache);
  const [settings, setSettings] = useState(_settingsCache);
  const [open,     setOpen]     = useState(false);
  // `switching` holds the *route id* currently being pinned. Was previously
  // the legacy "provider id" enum value — kept the name to minimise rename
  // churn, but the value space is now route ids (`pr-...`).
  const [switching, setSwitching] = useState(null);
  const [error,    setError]    = useState(null);
  const navigate = useNavigate();
  const ref = useRef(null);

  // Load on mount — always re-fetch when any of the three caches is empty.
  // `listAiProviders` is the canonical source of switch targets (Phase 1 of
  // the route-based switcher). `getConfig` / `getSettings` stay around for
  // the legacy fallback when a workspace has zero configured routes.
  const load = useCallback(async () => {
    if (_configCache && _routesCache && _groupsCache && _settingsCache) {
      setConfig(_configCache);
      setRoutes(_routesCache);
      setGroups(_groupsCache);
      setSettings(_settingsCache);
      return;
    }
    try {
      // `listRouteGroups` / `listAiProviders` / `getSettings` are all
      // wrapped in `.catch()` so a single endpoint failure (older backend,
      // RBAC mismatch, network blip) degrades to an empty array without
      // breaking the whole badge. `getConfig` is the only required call.
      const [cfg, routesResp, groupsResp, sett] = await Promise.all([
        api.getConfig(),
        api.listAiProviders().catch(() => ({ routes: [] })),
        api.listRouteGroups().catch(() => ({ groups: [] })),
        api.getSettings().catch(() => null),
      ]);
      _configCache   = cfg;
      _routesCache   = routesResp?.routes || [];
      _groupsCache   = groupsResp?.groups || [];
      _settingsCache = sett;
      setConfig(cfg);
      setRoutes(_routesCache);
      setGroups(_groupsCache);
      setSettings(sett);
    } catch { /* silent — badge degrades gracefully */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setError(null);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // ── Pin a route as the workspace default ──────────────────────────────────
  //
  // Replaces the legacy `saveApiKey(provider, "__use_existing__")` flip of
  // `runtimeActiveProvider` with the route-based primitive: POST
  // `/settings/ai-providers/:id/default` writes `isWorkspaceDefault = 1`
  // on the chosen `provider_routes` row (clearing it on every other row in
  // the same transaction — Migration 059's partial UNIQUE index). The
  // dispatcher's `resolveRoute()` honours this column before falling back
  // to env detection (`backend/src/aiProvider/registry.js:571-578`), so the
  // change takes effect on the next AI call without restart.
  //
  // Disabled routes (`route.enabled === 0`) and routes that already match
  // `isWorkspaceDefault` short-circuit — clicking the active row just
  // closes the dropdown.
  const setDefaultRoute = useCallback(async (route) => {
    if (!route || !route.enabled) return;
    if (route.isWorkspaceDefault) { setOpen(false); return; }

    setSwitching(route.id);
    setError(null);

    try {
      await api.setAiProviderDefault(route.id, true);
      // Force re-fetch — clear caches so the next render reads the updated
      // `isWorkspaceDefault` flag from `/settings/ai-providers` and the new
      // active-provider name from `/config`.
      invalidateConfigCache();
      const [freshCfg, freshRoutes, freshGroups, freshSett] = await Promise.all([
        api.getConfig(),
        api.listAiProviders().catch(() => ({ routes: [] })),
        api.listRouteGroups().catch(() => ({ groups: [] })),
        api.getSettings().catch(() => null),
      ]);
      _configCache   = freshCfg;
      _routesCache   = freshRoutes?.routes || [];
      _groupsCache   = freshGroups?.groups || [];
      _settingsCache = freshSett;
      setConfig(freshCfg);
      setRoutes(_routesCache);
      setGroups(_groupsCache);
      setSettings(freshSett);
      setOpen(false);
    } catch (err) {
      setError(err?.message?.includes("not found")
        ? "Route no longer exists. Refresh and try again."
        : "Switch failed. Open Settings to inspect the route.");
    } finally {
      setSwitching(null);
    }
  }, []);

  // ── Render: loading ────────────────────────────────────────────────────────
  if (!config) {
    return <div className="skeleton" style={{ width: 130, height: 26, borderRadius: 6, ...style }} />;
  }

  // ── Render: no provider ────────────────────────────────────────────────────
  if (!config.hasProvider) {
    return (
      <button onClick={() => navigate("/settings")} className="btn btn-ghost btn-sm"
        style={{ gap: 5, color: "var(--red)", borderColor: "#fca5a5", background: "var(--red-bg)", ...style }}>
        <AlertTriangle size={12} />
        <span style={{ fontSize: "0.75rem", fontWeight: 600 }}>Configure AI</span>
      </button>
    );
  }

  // ── Resolve the active route ──────────────────────────────────────────────
  // `routes` is the canonical switch-target set. The active row is the one
  // pinned as workspace default — `resolveRoute()` uses the same column for
  // dispatch (`backend/src/aiProvider/registry.js:571-578`), so this gives
  // operators a guarantee that what the badge shows is what dispatch fires.
  //
  // Env-only fallback: when no route is pinned (or no routes exist at all,
  // e.g. a fresh workspace using env keys), we fall back to the legacy
  // `config.provider` enum so the badge keeps rendering. Resolves to the
  // matching route by family when one exists; otherwise a synthetic shape
  // good enough to colour the chip.
  const allRoutes = Array.isArray(routes) ? routes : [];
  const allGroups = Array.isArray(groups) ? groups : [];
  const activeRoute =
    allRoutes.find((r) => r.isWorkspaceDefault) ||
    allRoutes.find((r) => r.family === config.provider) ||
    null;
  const c = styleForRoute(activeRoute) || FAMILY_STYLES[config.provider] || paletteStyle(config.provider || "?");

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0, ...style }}>

      {/* ── Badge trigger ── */}
      <button
        onClick={() => { setOpen(v => !v); setError(null); }}
        title="Switch AI provider"
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "4px 10px", borderRadius: 7,
          background: c.bg,
          border: `1px solid ${open ? c.color : c.border}`,
          cursor: "pointer", transition: "border-color 0.15s, box-shadow 0.15s",
          boxShadow: open ? `0 0 0 3px ${c.bg}` : "none",
        }}
      >
        {switching
          ? <RefreshCw size={12} color={c.color} className="spin" />
          : <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot, flexShrink: 0 }} />
        }
        <Brain size={12} color={c.color} />
        <span style={{ fontSize: "0.73rem", fontWeight: 600, color: c.color, whiteSpace: "nowrap" }}>
          {config.providerName}
        </span>
        <ChevronDown size={10} color={c.color}
          style={{ opacity: 0.7, transition: "transform 0.18s", transform: open ? "rotate(180deg)" : "none" }} />
      </button>

      {/* ── Dropdown ── */}
      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 200,
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 10, boxShadow: "0 8px 28px rgba(0,0,0,0.13)",
          minWidth: 236, overflow: "hidden",
        }}>

          {/* Header */}
          <div style={{ padding: "9px 12px 8px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: "0.68rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
              AI Provider
            </span>
            <button
              onClick={() => { setOpen(false); navigate("/settings"); }}
              style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", fontSize: "0.7rem", color: "var(--text3)", padding: "2px 5px", borderRadius: 4, transition: "all 0.1s" }}
              onMouseEnter={e => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg2)"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "var(--text3)"; e.currentTarget.style.background = "none"; }}
            >
              <Settings size={10} /> Manage keys
            </button>
          </div>

          {/* ── B4.6 — Route groups (read-only) ──
              Surfaced ABOVE the per-route list so operators see at a
              glance which groups exist and which agent roles dispatch
              through them. Pinning a group as workspace default is NOT
              available — the schema's `isWorkspaceDefault` column lives
              on `provider_routes`, not `route_groups`. Groups are
              reachable today only via `agent_configs.routeId = "rg-..."`,
              so the per-row CTA links to Agent Roles Settings as the
              assignment surface. Mutations (create/edit/delete) are a
              follow-up roadmap item per
              `docs/roadmap/ai-provider-bundle.md:397-405`. */}
          {allGroups.length > 0 && (
            <div style={{ padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ padding: "6px 13px 4px", fontSize: "0.67rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.07em", display: "flex", alignItems: "center", gap: 5 }}>
                <Layers size={10} />
                Route Groups
              </div>
              {allGroups.map((group) => {
                // Active = at least one agent role currently dispatches
                // through this group. We can't tell "primary" from the
                // routes list, so the indicator is binary: in use or not.
                const inUse = (group.usedByRoles || []).length > 0;
                const healthLabel = group.enabledMemberCount === group.memberCount
                  ? `${group.memberCount} route${group.memberCount !== 1 ? "s" : ""}`
                  : `${group.enabledMemberCount}/${group.memberCount} healthy`;
                return (
                  <button
                    key={group.id}
                    onClick={() => { setOpen(false); navigate("/settings"); }}
                    title={inUse
                      ? `In use by: ${group.usedByRoles.join(", ")}. Click to manage in Agent Roles.`
                      : "Unassigned. Click to assign to an agent role in Settings."}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      width: "100%", padding: "7px 13px",
                      background: "none", border: "none", cursor: "pointer",
                      textAlign: "left", transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg2)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                  >
                    <Layers size={12} color={inUse ? "var(--accent)" : "var(--text3)"} style={{ flexShrink: 0, opacity: inUse ? 1 : 0.55 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: "0.82rem", fontWeight: inUse ? 600 : 400,
                        color: "var(--text)", lineHeight: 1.3,
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {group.name}
                      </div>
                      <div style={{
                        fontSize: "0.68rem", color: "var(--text3)", marginTop: 1,
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {group.strategyLabel || group.strategy} · {healthLabel}
                        {inUse ? ` · ${group.usedByRoles.length} role${group.usedByRoles.length !== 1 ? "s" : ""}` : ""}
                      </div>
                    </div>
                    <span style={{ fontSize: "0.67rem", color: "var(--text3)", flexShrink: 0 }}>
                      {inUse ? "Manage" : "Assign"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* ── Configured routes — one-click pin-as-default ── */}
          {allRoutes.length > 0 ? (
            <div style={{ padding: "4px 0", maxHeight: 340, overflowY: "auto" }}>
              {allRoutes.map((route) => {
                const sty       = styleForRoute(route);
                const isActive  = !!route.isWorkspaceDefault;
                const isBusy    = switching === route.id;
                const isEnabled = !!route.enabled;
                const health    = routeHealth(route);
                // Health → dot opacity. `unknown` (never probed) renders at
                // the same opacity as a non-active row so the operator can
                // still see the family colour. `unhealthy` dims further so
                // the row reads as a warning at a glance.
                const dotOpacity = !isEnabled ? 0.2
                  : isActive ? 1
                  : health === "unhealthy" ? 0.35
                  : health === "healthy" ? 0.85
                  : 0.45;
                return (
                  <button
                    key={route.id}
                    onClick={() => setDefaultRoute(route)}
                    disabled={!!switching || !isEnabled}
                    title={!isEnabled ? "Route disabled — re-enable in Settings to switch" : route.displayLabel || route.name}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      width: "100%", padding: "8px 13px",
                      background: isActive ? sty.activeBg : "none",
                      border: "none",
                      cursor: !isEnabled ? "not-allowed"
                        : switching ? (isBusy ? "wait" : "default")
                        : "pointer",
                      textAlign: "left", transition: "background 0.1s",
                      opacity: !isEnabled ? 0.55 : (switching && !isBusy) ? 0.45 : 1,
                    }}
                    onMouseEnter={(e) => { if (!isActive && !switching && isEnabled) e.currentTarget.style.background = "var(--bg2)"; }}
                    onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                  >
                    <span style={{
                      width: 7, height: 7, borderRadius: "50%",
                      background: sty.dot, flexShrink: 0,
                      opacity: dotOpacity,
                      // Red outline on an unhealthy row so the colour-blind
                      // path still reads "this route has a problem".
                      boxShadow: (isEnabled && health === "unhealthy") ? "0 0 0 1.5px rgba(220,38,38,0.55)" : "none",
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: "0.82rem",
                        fontWeight: isActive ? 600 : 400,
                        color: isActive ? sty.color : "var(--text)",
                        lineHeight: 1.3,
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {route.displayLabel || route.name}
                      </div>
                      <div style={{
                        fontSize: "0.68rem", color: "var(--text3)", marginTop: 1,
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {route.model}
                        {route.costTier ? ` · ${route.costTier}` : ""}
                      </div>
                    </div>
                    {isBusy
                      ? <RefreshCw size={12} color={sty.color} className="spin" style={{ flexShrink: 0 }} />
                      : !isEnabled
                      ? <CircleSlash size={12} color="var(--text3)" style={{ flexShrink: 0 }} />
                      : isActive
                      ? <Check size={12} color={sty.color} style={{ flexShrink: 0 }} />
                      : <span style={{ fontSize: "0.68rem", color: "var(--text3)", flexShrink: 0 }}>Set default</span>
                    }
                  </button>
                );
              })}
            </div>
          ) : (
            // Empty-state — no `provider_routes` rows. Workspaces in this
            // state are still dispatching via env detection; surface the
            // CTA to migrate to row-based config instead of silently
            // rendering a useless dropdown.
            <div style={{ padding: "12px 14px", fontSize: "0.75rem", color: "var(--text3)", lineHeight: 1.5 }}>
              No AI providers configured. Add one in{" "}
              <button
                onClick={() => { setOpen(false); navigate("/settings"); }}
                style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", cursor: "pointer", fontWeight: 600, textDecoration: "underline" }}
              >
                Settings
              </button>
              {" "}to enable per-route switching.
            </div>
          )}

          {/* Error banner — pinned to the bottom of the route list. */}
          {error && (
            <div style={{ padding: "7px 12px", fontSize: "0.72rem", color: "var(--red)", borderTop: "1px solid var(--border)", background: "var(--red-bg)", lineHeight: 1.5 }}>
              {error}
            </div>
          )}

          <div style={{ height: 4 }} />
        </div>
      )}
    </div>
  );
}