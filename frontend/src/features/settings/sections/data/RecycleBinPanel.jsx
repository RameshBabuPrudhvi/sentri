import React, { useCallback, useState } from "react";
import {
  AlertCircle, FileText, FolderOpen, Play, Trash2,
} from "lucide-react";
import { api } from "../../../../api.js";
import { useRecycleBinQuery } from "../../../../hooks/queries/useSettingsQueries.js";
import SectionTitle from "../../shared/SectionTitle.jsx";
import RecycleBinGroup from "./RecycleBinGroup.jsx";

/**
 * Recycle bin panel — restore or permanently purge soft-deleted projects /
 * tests / runs (ENH-020). Confirmation modal on purge. Extracted from
 * Settings.jsx `RecycleBinTab` (GAP-002).
 */
export default function RecycleBinPanel() {
  const [busy, setBusy] = useState({});
  const [error, setError] = useState(null);

  const recycleQuery = useRecycleBinQuery();
  const data = recycleQuery.data ?? null;
  const loading = recycleQuery.isLoading;
  const load = useCallback(() => recycleQuery.refetch(), [recycleQuery]);
  const displayError = error || recycleQuery.error?.message || null;

  async function handleRestore(type, id) {
    setError(null);
    setBusy((b) => ({ ...b, [`${type}:${id}`]: "restore" }));
    try {
      await api.restoreItem(type, id);
      await load();
    } catch (e) {
      setError(e.message || "Restore failed");
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[`${type}:${id}`]; return n; });
    }
  }

  async function handlePurge(type, id, name) {
    if (!window.confirm(`Permanently delete "${name}"? This cannot be undone.`)) return;
    setError(null);
    setBusy((b) => ({ ...b, [`${type}:${id}`]: "purge" }));
    try {
      await api.purgeItem(type, id);
      await load();
    } catch (e) {
      setError(e.message || "Purge failed");
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[`${type}:${id}`]; return n; });
    }
  }

  const total = data ? (data.projects.length + data.tests.length + data.runs.length) : 0;

  if (loading) return (
    <div className="text-sm text-muted members-loading">Loading recycle bin…</div>
  );

  if (displayError) return (
    <div className="card card-padded members-error">
      <AlertCircle size={15} /> {displayError}
    </div>
  );

  return (
    <div className="flex-col gap-lg">
      <SectionTitle
        icon={<Trash2 size={16} color="var(--amber)" />}
        title="Recycle Bin"
        sub={total === 0 ? "No deleted items" : `${total} deleted item${total !== 1 ? "s" : ""} — restore or permanently purge`}
      />
      {total === 0 ? (
        <div className="card card-padded data-recycle-empty">
          <div className="data-recycle-empty__emoji">🗑️</div>
          <div className="text-sm">The recycle bin is empty.</div>
          <div className="text-xs text-muted data-recycle-empty__hint">
            Deleted tests, projects, and runs will appear here.
          </div>
        </div>
      ) : (
        <div className="flex-col gap-lg">
          <RecycleBinGroup
            title="Projects"
            icon={<FolderOpen size={12} />}
            items={data.projects}
            type="project"
            nameKey="name"
            subKey="url"
            busy={busy}
            onRestore={handleRestore}
            onPurge={handlePurge}
          />
          <RecycleBinGroup
            title="Tests"
            icon={<FileText size={12} />}
            items={data.tests}
            type="test"
            nameKey="name"
            subKey="description"
            busy={busy}
            onRestore={handleRestore}
            onPurge={handlePurge}
          />
          <RecycleBinGroup
            title="Runs"
            icon={<Play size={12} />}
            items={data.runs}
            type="run"
            nameKey="id"
            subKey="type"
            busy={busy}
            onRestore={handleRestore}
            onPurge={handlePurge}
          />
        </div>
      )}
    </div>
  );
}
