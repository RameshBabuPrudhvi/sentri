import React, { useCallback, useEffect, useState } from "react";
import {
  AlertCircle, Check, Download as DownloadIcon, ListChecks, Plus, Route as RouteIcon,
} from "lucide-react";
import { api } from "../../../../api.js";
import SectionTitle from "../../shared/SectionTitle.jsx";
import { PR_FORM_EMPTY } from "./providerRoutes.constants.js";
import { detectFallbackCycle } from "./providerRoutes.utils.js";
import ProviderRoutesForm from "./ProviderRoutesForm.jsx";
import ProviderRouteRow from "./ProviderRouteRow.jsx";
import WorkspaceSpendCapsPanel from "./WorkspaceSpendCapsPanel.jsx";
import ProviderRoutesIO from "./ProviderRoutesIO.jsx";
import AuditLogSubtab from "./AuditLogSubtab.jsx";
import AiRequestLogSubtab from "./AiRequestLogSubtab.jsx";

/**
 * Provider Routes section (B3.1). Per-row CRUD for `provider_routes` — the
 * dispatch target every agent role pins via `routeId`. Composes
 * WorkspaceSpendCapsPanel (B3.7), ProviderRoutesIO (B3.5), AuditLogSubtab
 * (B3.9), and AiRequestLogSubtab (B2.5). Extracted from Settings.jsx (GAP-002).
 */
export default function ProviderRoutesSection() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(PR_FORM_EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ioBusy, setIoBusy] = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  // Per-row in-flight state keyed by route id:
  //   { kind: "probing" | "rotating" | "deleting" | "ok" | "err", ... }
  const [rowState, setRowState] = useState({});
  // Plaintext key buffer for rotate-key, per row. Never mirrored into `rows`.
  const [rotateBuf, setRotateBuf] = useState({});
  const [rotateOpen, setRotateOpen] = useState(null);
  const [showKey, setShowKey] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.listProviderRoutes();
      setRows(res?.routes || []);
    } catch (err) {
      setError(err.message || "Failed to load provider routes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function resetForm() {
    setForm(PR_FORM_EMPTY);
    setError("");
    setShowKey(false);
  }

  function buildPayload(src) {
    const numOrNull = (v) => {
      if (v === "" || v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const payload = {
      name: src.name.trim(),
      family: src.family,
      protocol: src.protocol,
      baseUrl: src.baseUrl.trim() || null,
      model: src.model.trim(),
      enabled: !!src.enabled,
      rpmLimit: numOrNull(src.rpmLimit),
      tpmLimit: numOrNull(src.tpmLimit),
      cacheEnabled: !!src.cacheEnabled,
      cacheTtlSec: numOrNull(src.cacheTtlSec) ?? 0,
      fallbackRouteId: src.fallbackRouteId || null,
    };
    if (src.apiKey && src.apiKey.trim()) payload.apiKey = src.apiKey.trim();
    return payload;
  }

  async function save(e) {
    e.preventDefault();
    setError("");
    if (!form.name.trim()) { setError("Name is required."); return; }
    if (!form.model.trim()) { setError("Model is required."); return; }
    setBusy(true);
    try {
      const payload = buildPayload(form);
      if (form.id) await api.updateProviderRoute(form.id, payload);
      else await api.createProviderRoute(payload);
      resetForm();
      await load();
    } catch (err) {
      setError(err.message || "Failed to save provider route.");
    } finally {
      setBusy(false);
    }
  }

  function edit(row) {
    setError("");
    setForm({
      id: row.id,
      name: row.name || "",
      family: row.family || "openai",
      protocol: row.protocol || "openai",
      baseUrl: row.baseUrl || "",
      model: row.model || "",
      apiKey: "",
      enabled: row.enabled === 1 || row.enabled === true,
      rpmLimit: row.rpmLimit ?? "",
      tpmLimit: row.tpmLimit ?? "",
      cacheEnabled: row.cacheEnabled === 1 || row.cacheEnabled === true,
      cacheTtlSec: row.cacheTtlSec ?? "",
      fallbackRouteId: row.fallbackRouteId || "",
    });
  }

  async function probe(id) {
    setRowState((s) => ({ ...s, [id]: { kind: "probing" } }));
    try {
      const res = await api.probeProviderRoute(id);
      setRowState((s) => ({ ...s, [id]: { kind: "ok", caps: res.capabilities } }));
      load();
    } catch (err) {
      setRowState((s) => ({ ...s, [id]: { kind: "err", msg: err.message || "probe_failed" } }));
    }
  }

  async function rotate(id) {
    const key = (rotateBuf[id] || "").trim();
    if (!key) return;
    setRowState((s) => ({ ...s, [id]: { kind: "rotating" } }));
    try {
      const res = await api.rotateProviderRouteKey(id, key);
      setRowState((s) => ({ ...s, [id]: { kind: "ok", lastFour: res?.lastFour } }));
      setRotateBuf((b) => { const n = { ...b }; delete n[id]; return n; });
      setRotateOpen(null);
      await load();
    } catch (err) {
      setRowState((s) => ({ ...s, [id]: { kind: "err", msg: err.message || "rotate_failed" } }));
    }
  }

  async function del(id) {
    if (!window.confirm("Delete this provider route? Agent roles pinned to it will fall back to env detection.")) return;
    setRowState((s) => ({ ...s, [id]: { kind: "deleting" } }));
    try {
      await api.deleteProviderRoute(id);
      if (form.id === id) resetForm();
      await load();
      setRowState((s) => { const n = { ...s }; delete n[id]; return n; });
    } catch (err) {
      setRowState((s) => ({ ...s, [id]: { kind: "err", msg: err.message || "delete_failed" } }));
    }
  }

  async function exportRoutes() {
    setIoBusy(true);
    setImportMsg(null);
    try {
      const payload = await api.exportRoutes();
      const count = payload?.routes?.length ?? 0;
      setImportMsg({ type: "ok", text: `Exported ${count} route(s).` });
    } catch (err) {
      setImportMsg({ type: "err", text: err.message || "Export failed." });
    } finally {
      setIoBusy(false);
    }
  }

  async function importRoutes(file, mode) {
    setIoBusy(true);
    setImportMsg(null);
    try {
      const res = await api.importRoutes(file, mode);
      await load();
      const parts = [];
      if (res.created) parts.push(`${res.created} created`);
      if (res.overwritten) parts.push(`${res.overwritten} overwritten`);
      if (res.renamed) parts.push(`${res.renamed} renamed`);
      if (res.skipped) parts.push(`${res.skipped} skipped`);
      if (res.errors?.length) {
        parts.push(`${res.errors.length} error${res.errors.length === 1 ? "" : "s"}`);
        // eslint-disable-next-line no-console
        console.warn("[Provider Routes import] errors:", res.errors);
      }
      setImportMsg({
        type: res.errors?.length ? "err" : "ok",
        text: parts.length ? parts.join(" · ") : "No changes applied.",
      });
    } catch (err) {
      setImportMsg({ type: "err", text: err.message || "Import failed." });
    } finally {
      setIoBusy(false);
    }
  }

  // Exclude the row being edited so the UI can't offer a self-loop. The
  // repo's `wouldCreateCycle` catches longer cycles server-side.
  const fallbackOptions = rows.filter((r) => r.id !== form.id);
  const cycleAt = detectFallbackCycle(rows, form.id, form.fallbackRouteId);
  const cycleAtName = cycleAt ? (rows.find((r) => r.id === cycleAt)?.name || cycleAt) : null;

  // UX-AUDIT (May 2026): the legacy "everything in one big card" layout
  // made it impossible to tell where one form ended and the next began —
  // operators couldn't distinguish "Save caps" (spend-caps form) from
  // "Create route" (route-create form), and the IO bar looked like a
  // field of the create form. Industry-standard pattern (Stripe Dashboard,
  // Vercel project settings, AWS Console): page title sits OUTSIDE any
  // card; each logical unit (caps, IO, create-form, route list, audit
  // log, request log) gets its OWN card with its own heading. Visual
  // separation between cards (24px gap) makes the form boundaries
  // immediately legible.
  return (
    <div className="st-pr-section">
      <SectionTitle
        icon={<RouteIcon size={16} color="var(--accent)" />}
        title="Provider Routes"
        sub="Bundle protocol + endpoint + model + encrypted API key. Agent roles pin a route via routeId."
      />
      {error && (
        <div className="st-status-err st-agent-error">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      {/* Card #1 — Workspace spend caps. Distinct form with its own
          "Save caps" CTA. No overlap with the route create form below. */}
      <div className="card card-padded">
        <WorkspaceSpendCapsPanel />
      </div>

      {/* Card #2 — Export / import bar. Sibling action surface, NOT a
          field of any form. Visually separated so the user doesn't
          mistake the file-mode dropdown for a route attribute. */}
      <div className="card card-padded">
        <div className="st-pr-card-title">
          <DownloadIcon size={13} /> Backup &amp; restore
        </div>
        <div className="text-xs text-muted st-pr-card-sub">
          Export every route as a schema-v1 JSON file, or import routes from another workspace. Secrets are never included — re-supply API keys via the per-row Rotate key after import.
        </div>
        <ProviderRoutesIO
          onExport={exportRoutes}
          onImport={importRoutes}
          busy={ioBusy}
          importMsg={importMsg}
        />
      </div>

      {/* Card #3 — Create / edit route form. The "Create route" CTA is
          unambiguously the submit for this card only. When the user
          clicks "Edit" on a route below, the form re-binds to that
          row and the CTA reads "Update route" (handled inside
          ProviderRoutesForm). */}
      <div className="card card-padded">
        <div className="st-pr-card-title">
          {form.id ? <Check size={13} /> : <Plus size={13} />}
          {form.id ? "Edit route" : "Create a new route"}
        </div>
        <div className="text-xs text-muted st-pr-card-sub">
          {form.id
            ? "Update the configuration below. Leave the API key empty to keep the stored value."
            : "Bundle a provider (family + protocol + model + key) into a named route. Agent roles pin a route via routeId so dispatch is deterministic."}
        </div>
        <ProviderRoutesForm
          form={form}
          setForm={setForm}
          busy={busy}
          showKey={showKey}
          setShowKey={setShowKey}
          fallbackOptions={fallbackOptions}
          cycleAtName={cycleAtName}
          onSave={save}
          onCancel={resetForm}
        />
      </div>

      {/* Card #4 — Existing routes list. Empty-state message lives
          inside the card so an empty workspace still has a visible
          surface to read against. */}
      <div className="card card-padded">
        <div className="st-pr-card-title">
          <ListChecks size={13} />
          Configured routes
          {!loading && rows.length > 0 && (
            <span className="st-pr-card-title__count">({rows.length})</span>
          )}
        </div>
        {loading ? (
          <div className="text-sm text-muted st-pr-loading">Loading provider routes…</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-muted st-pr-empty">
            No provider routes configured. Create one above — agent roles need a routeId to dispatch.
          </div>
        ) : (
          <div className="st-pr-rows">
            {rows.map((row) => (
              <ProviderRouteRow
                key={row.id}
                row={row}
                rows={rows}
                rowState={rowState[row.id]}
                rotateOpen={rotateOpen === row.id}
                setRotateOpen={setRotateOpen}
                rotateBuf={rotateBuf}
                setRotateBuf={setRotateBuf}
                onEdit={edit}
                onDelete={del}
                onProbe={probe}
                onRotate={rotate}
              />
            ))}
          </div>
        )}
      </div>

      {/* Cards #5 + #6 — Audit log + AI request log. Each subtab
          already renders its own internal padding/panel chrome, so
          we just wrap them in a card surface for visual parity with
          the forms above. */}
      <div className="card card-padded">
        <AuditLogSubtab rows={rows} />
      </div>
      <div className="card card-padded">
        <AiRequestLogSubtab rows={rows} />
      </div>
    </div>
  );
}
