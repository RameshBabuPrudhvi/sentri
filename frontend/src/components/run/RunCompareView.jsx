import React from "react";

function statusBadge(status) {
  const tone = status === "passed" ? "badge-green" : status === "failed" ? "badge-red" : "badge-gray";
  return <span className={`badge ${tone}`}>{status || "—"}</span>;
}

export default function RunCompareView({ data, loading, error }) {
  if (loading) return <div className="card" style={{ padding: 12 }}>Loading comparison…</div>;
  if (error) return <div className="card" style={{ padding: 12, color: "var(--red)" }}>Failed to load comparison.</div>;
  if (!data) return null;

  return (
    <div className="card" style={{ padding: 12, marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Run Comparison</h3>
      <p style={{ color: "var(--text3)", marginTop: 0 }}>
        Flipped: {data.summary?.flipped || 0} · Added: {data.summary?.added || 0} · Removed: {data.summary?.removed || 0} · Unchanged: {data.summary?.unchanged || 0}
      </p>
      {(!data.diffs || data.diffs.length === 0) && (
        <div style={{ color: "var(--text3)", fontSize: "0.82rem" }}>
          No prior run found to compare against.
        </div>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        {(data.diffs || []).map((d) => (
          <div key={d.testId} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <strong>{d.testName || d.testId}</strong>
              <span className="badge badge-gray">{d.changeType}</span>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
              <span>Current: {statusBadge(d.currentStatus)}</span>
              <span>Previous: {statusBadge(d.previousStatus)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
