import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    async function load() {
      try {
        const res = await api.getDashboard();
        console.log("Dashboard:", res);
        setData(res);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  if (loading) {
    return <div style={{ padding: 40 }}>Loading...</div>;
  }

  const runs = data?.recentRuns || [];

  const activeRuns = runs.filter(
    (r) => r.status === "running" || r.status === "queued"
  );

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>

      {/* 🔹 TOP STATS */}
      <div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
        <Stat title="Projects" value={data?.projectsCount || 0} />
        <Stat title="Runs" value={data?.runsCount || 0} />
        <Stat title="Tests" value={data?.testsCount || 0} />
        <Stat title="Pass Rate" value={data?.passRate || "-"} />
      </div>

      {/* 🔹 ACTIVE RUNS */}
      {activeRuns.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>
            Active
          </div>

          {activeRuns.map((r) => (
            <div
              key={r.id}
              style={{
                padding: 10,
                borderBottom: "1px solid #eee",
                cursor: "pointer",
              }}
              onClick={() => navigate(`/runs/${r.id}`)}
            >
              <b>{r.projectName || "Project"}</b> — {r.status}
            </div>
          ))}
        </div>
      )}

      {/* 🔹 RECENT RUNS (MAIN) */}
      <div className="card">
        <div style={{ padding: 16, fontWeight: 600 }}>
          Recent Runs
        </div>

        {runs.length === 0 ? (
          <div style={{ padding: 20, color: "gray" }}>
            No activity yet
          </div>
        ) : (
          runs.map((r) => (
            <div
              key={r.id}
              style={{
                padding: 14,
                borderTop: "1px solid #eee",
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
              }}
              onClick={() => navigate(`/runs/${r.id}`)}
            >
              <div>
                <div style={{ fontWeight: 500 }}>
                  {r.projectName || "Project"}
                </div>
                <div style={{ fontSize: 12, color: "gray" }}>
                  {new Date(
                    r.startedAt || r.createdAt
                  ).toLocaleString()}
                </div>
              </div>

              <StatusBadge status={r.status} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* 🔹 STAT CARD */
function Stat({ title, value }) {
  return (
    <div className="card" style={{ flex: 1, padding: 16 }}>
      <div style={{ fontSize: 12, color: "gray" }}>{title}</div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

/* 🔹 STATUS BADGE */
function StatusBadge({ status }) {
  const colors = {
    completed: "#16a34a",
    running: "#2563eb",
    failed: "#dc2626",
    queued: "#f59e0b",
  };

  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 500,
        color: colors[status] || "gray",
      }}
    >
      {status}
    </div>
  );
}