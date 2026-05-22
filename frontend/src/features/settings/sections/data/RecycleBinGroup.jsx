import React from "react";
import { RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { fmtDeletedDate } from "../../shared/formatters.js";

/**
 * One labelled group inside the RecycleBin section (Projects / Tests / Runs).
 * Returns null when `items` is empty so the parent renders only non-empty
 * groups. Extracted from Settings.jsx `RecycleBinSection` (GAP-002).
 */
export default function RecycleBinGroup({ title, icon, items, type, nameKey = "name", subKey = null, busy, onRestore, onPurge }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="text-xs text-muted font-semi recycle-section__title">
        <span className="recycle-section__title-icon">{icon}</span>
        {title} ({items.length})
      </div>
      <div className="flex-col gap-xs">
        {items.map((item) => {
          const key = `${type}:${item.id}`;
          const busyState = busy[key];
          const displayName = item[nameKey] || item.id;
          return (
            <div key={item.id} className="card recycle-item">
              <div className="flex-1 recycle-item__body">
                <div className="text-sm font-semi recycle-item__name">
                  {displayName}
                </div>
                {subKey && item[subKey] && (
                  <div className="text-xs text-muted recycle-item__sub">
                    {item[subKey]}
                  </div>
                )}
                <div className="text-xs text-muted recycle-item__deleted">
                  Deleted {fmtDeletedDate(item.deletedAt)}
                </div>
              </div>
              <div className="recycle-item__actions">
                <button
                  className="btn btn-ghost btn-xs"
                  disabled={!!busyState}
                  onClick={() => onRestore(type, item.id)}
                  title="Restore"
                  aria-label={`Restore ${displayName}`}
                >
                  {busyState === "restore" ? <RefreshCw size={11} className="spin" /> : <RotateCcw size={11} />}
                  Restore
                </button>
                <button
                  className="btn btn-danger btn-xs"
                  disabled={!!busyState}
                  onClick={() => onPurge(type, item.id, displayName)}
                  title="Permanently delete"
                  aria-label={`Permanently delete ${displayName}`}
                >
                  {busyState === "purge" ? <RefreshCw size={11} className="spin" /> : <Trash2 size={11} />}
                  Purge
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
