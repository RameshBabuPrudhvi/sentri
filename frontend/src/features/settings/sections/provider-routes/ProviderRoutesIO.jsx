import React, { useRef, useState } from "react";
import {
  AlertCircle, Check, Download, Upload as UploadIcon,
} from "lucide-react";

/**
 * B3.5 — Export/import action bar. Rendered above the route form so admins can
 * bulk-move routes between workspaces without scrolling past the per-row list.
 * Mode selector defaults to "skip" — the safest option when re-importing into a
 * workspace that already has routes (no existing data is touched). The file
 * input is hidden + driven by a button click so the styling stays uniform with
 * the rest of the action bar. Extracted from Settings.jsx (GAP-002).
 */
export default function ProviderRoutesIO({ onExport, onImport, busy, importMsg }) {
  const fileRef = useRef(null);
  const [mode, setMode] = useState("skip");
  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    onImport(file, mode);
    // Reset so re-selecting the same file fires onChange again. Without this,
    // importing the same file twice in a row silently no-ops.
    e.target.value = "";
  }
  return (
    <div className="st-pr-io-bar">
      <div className="st-pr-io-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onExport}
          disabled={busy}
          title="Download every provider route in this workspace as a schema-v1 JSON file. Secrets are never included."
        >
          <Download size={13} /> Export
        </button>
        <label className="st-pr-io-mode">
          <span className="text-xs text-muted">On collision</span>
          <select
            className="input st-pr-io-mode-select"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            disabled={busy}
          >
            <option value="skip">Skip existing</option>
            <option value="overwrite">Overwrite by name</option>
            <option value="rename">Rename (append -2, -3, …)</option>
          </select>
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title="Upload a schema-v1 JSON file to upsert routes into this workspace. Each imported route is re-probed; you'll still need to supply API keys via Rotate key."
        >
          <UploadIcon size={13} /> Import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={handleFileChange}
          className="st-pr-io-file"
        />
      </div>
      {importMsg && (
        <div className={importMsg.type === "ok" ? "st-status-ok" : "st-status-err"}>
          {importMsg.type === "ok" ? <Check size={12} /> : <AlertCircle size={12} />} {importMsg.text}
        </div>
      )}
    </div>
  );
}
