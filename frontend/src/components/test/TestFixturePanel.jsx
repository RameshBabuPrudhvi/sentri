import React, { useCallback, useEffect, useState } from "react";
import { Upload, Database, CheckCircle2, AlertTriangle } from "lucide-react";
import { api } from "../../api.js";
import { fmtDateTime } from "../../utils/formatters.js";

/**
 * CAP-001: per-test data-driven fixture upload + history panel.
 *
 * - CSV / JSON upload (textarea-based, no file picker — keeps the panel
 *   keyboard-accessible and avoids drag-drop edge cases).
 * - Lists historical fixtures for this test (newest version first), grouped
 *   by `(testId, version)` so a re-upload at the same code version is shown
 *   as a single row rather than duplicated history.
 * - Optional `iterationCap` override field — server clamps to [1, 100] and
 *   reports truncation back via `truncated: true` in the response.
 *
 * The component lives in `frontend/src/components/test/` per AGENTS.md (no
 * helpers defined mid-component file), and is mounted from `TestDetail.jsx`
 * to satisfy the PROC-001 no-orphan-routes invariant for the two new
 * fixture endpoints in `frontend/src/api.js`.
 *
 * @param {{ testId: string, codeVersion: number }} props
 */
export default function TestFixturePanel({ testId, codeVersion }) {
  const [format, setFormat] = useState("csv");
  const [csvText, setCsvText] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [iterationCap, setIterationCap] = useState("");
  const [fixtures, setFixtures] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const reload = useCallback(async () => {
    if (!testId) return;
    try {
      const rows = await api.getTestFixtures(testId);
      setFixtures(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setError(err.message || "Failed to load fixtures.");
    }
  }, [testId]);

  useEffect(() => { reload(); }, [reload]);

  async function handleUpload() {
    setError(null); setSuccess(null);
    let payload;
    if (format === "csv") {
      if (!csvText.trim()) { setError("Paste CSV content first (header row + at least one data row)."); return; }
      payload = { format: "csv", csvText };
    } else {
      let rows;
      try { rows = JSON.parse(jsonText); }
      catch { setError("JSON is not valid — expected an array of row objects."); return; }
      if (!Array.isArray(rows) || rows.length === 0) {
        setError("JSON must be a non-empty array of row objects."); return;
      }
      payload = { format: "json", rows };
    }
    const capNum = Number(iterationCap);
    if (iterationCap !== "" && Number.isFinite(capNum)) payload.iterationCap = capNum;

    // CAP-001: re-uploading at the same code version replaces the prior
    // fixture in place (`testFixtureRepo.upsertFixture` is keyed on
    // `(testId, version)`). The server log comment documents this, but
    // users hitting the panel directly can lose 10s of rows of fixture
    // data with no warning — surface a one-time confirm before the
    // destructive write. Different-version uploads (after an AI fix
    // bumps codeVersion) don't overwrite anything, so they skip the
    // prompt.
    const existingActive = fixtures.find((f) => f.version === codeVersion);
    if (existingActive && typeof window !== "undefined" && typeof window.confirm === "function") {
      const ok = window.confirm(
        `A fixture already exists for version ${codeVersion} (${existingActive.rows?.length ?? 0} row(s)). ` +
        "Saving will replace it. Continue?",
      );
      if (!ok) return;
    }

    setLoading(true);
    try {
      const res = await api.uploadTestFixture(testId, payload);
      setSuccess(
        `Saved ${res.rows?.length ?? 0} row(s) at version ${res.version}` +
        (res.truncated ? ` (truncated to cap ${res.capApplied})` : ""),
      );
      setCsvText(""); setJsonText("");
      await reload();
    } catch (err) {
      setError(err.message || "Upload failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card card-padded">
      <div className="td-card-header">
        <div className="td-card-icon"><Database size={14} color="var(--text2)" /></div>
        <h2 className="td-card-title">Data-driven fixtures</h2>
        <span className="badge badge-gray" style={{ marginLeft: "auto" }}>v{codeVersion}</span>
      </div>

      <p className="td-desc-text" style={{ marginTop: 4 }}>
        Upload a CSV / JSON fixture to run this test once per row. Use{" "}
        <code>{"{{column}}"}</code> placeholders in the Playwright code — each
        iteration substitutes the matching column value. Fixtures are scoped to
        the current code version; re-uploading after an AI fix is required.
      </p>

      <div className="flex" style={{ gap: 8, alignItems: "center", marginTop: 12 }}>
        <select className="input" value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="csv">CSV</option>
          <option value="json">JSON array</option>
        </select>
        <input
          className="input"
          type="number"
          min="1"
          max="100"
          placeholder="iteration cap (default 10)"
          value={iterationCap}
          onChange={(e) => setIterationCap(e.target.value)}
          style={{ maxWidth: 200 }}
        />
        <button
          className="btn btn-primary btn-sm"
          onClick={handleUpload}
          disabled={loading}
          style={{ marginLeft: "auto" }}
        >
          <Upload size={13} /> {loading ? "Uploading…" : "Save fixture"}
        </button>
      </div>

      {format === "csv" ? (
        <textarea
          className="input"
          rows={6}
          style={{ marginTop: 8, fontFamily: "var(--font-mono)" }}
          placeholder={"email,role\na@example.com,admin\nb@example.com,viewer"}
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
        />
      ) : (
        <textarea
          className="input"
          rows={6}
          style={{ marginTop: 8, fontFamily: "var(--font-mono)" }}
          placeholder={'[\n  { "email": "a@example.com", "role": "admin" }\n]'}
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
        />
      )}

      {error && (
        <div className="td-edit-error" style={{ marginTop: 8 }}>
          <AlertTriangle size={12} /> {error}
        </div>
      )}
      {success && (
        <div className="td-info-text" style={{ marginTop: 8, color: "var(--green)" }}>
          <CheckCircle2 size={12} /> {success}
        </div>
      )}

      {fixtures.length > 0 && (
        <table className="table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Version</th><th>Format</th><th>Rows</th><th>Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {fixtures.map((f) => (
              <tr key={`${f.testId}-${f.version}`}>
                <td>v{f.version}{f.version === codeVersion && <span className="badge badge-green" style={{ marginLeft: 6 }}>active</span>}</td>
                <td>{(f.format || "").toUpperCase()}</td>
                <td>{Array.isArray(f.rows) ? f.rows.length : 0}</td>
                <td><span className="td-info-text">{fmtDateTime(f.createdAt)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
