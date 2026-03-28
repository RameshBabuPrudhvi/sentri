import React, { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

export default function Work() {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);

  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  const navigate = useNavigate();

  useEffect(() => {
  async function loadRuns() {
    try {
      console.log("🚀 Loading Work page...");

      // 1. Get projects
      const projectsRes = await api.getProjects();
      console.log("📦 PROJECTS RESPONSE:", projectsRes);

      const projects = Array.isArray(projectsRes)
        ? projectsRes
        : projectsRes?.data || [];

      console.log("📦 PROJECTS LIST:", projects);

      if (!projects.length) {
        console.warn("❌ No projects found");
      }

      let allRuns = [];

      // 2. Fetch runs per project
      for (const project of projects) {
        console.log("➡️ Fetching runs for:", project);

        try {
          const res = await api.getRuns(project.id);
          console.log(`📊 Runs for ${project.id}:`, res);

          let runs = [];

          if (Array.isArray(res)) runs = res;
          else if (res?.runs) runs = res.runs;
          else if (res?.data?.runs) runs = res.data.runs;
          else if (Array.isArray(res?.data)) runs = res.data;

          runs = runs.map((r) => ({
            ...r,
            projectName: project.name,
          }));

          allRuns.push(...runs);
        } catch (err) {
          console.error("❌ Failed runs for project:", project.id, err);
        }
      }

      console.log("🔥 FINAL RUNS:", allRuns);

      // 3. FALLBACK (IMPORTANT)
      if (!allRuns.length) {
        console.warn("⚠️ Using dashboard fallback");

        const dash = await api.getDashboard();
        console.log("📊 DASHBOARD:", dash);

        const fallbackRuns = dash?.recentRuns || [];

        setRuns(fallbackRuns);
      } else {
        setRuns(allRuns);
      }
    } catch (err) {
      console.error("💥 Work page failed:", err);
    } finally {
      setLoading(false);
    }
  }

  loadRuns();
}, []);

  /* 🔹 FILTER + SEARCH + SORT */
  const filteredRuns = useMemo(() => {
    let result = [...runs];

    // filter by status
    if (filter !== "all") {
      result = result.filter((r) => r.status === filter);
    }

    // search by project name
    if (search.trim()) {
      result = result.filter((r) =>
        (r.projectName || "")
          .toLowerCase()
          .includes(search.toLowerCase())
      );
    }

    // sort latest first
    result.sort(
      (a, b) =>
        new Date(b.startedAt || b.createdAt) -
        new Date(a.startedAt || a.createdAt)
    );

    return result;
  }, [runs, filter, search]);

  if (loading) {
    return <div style={{ padding: 40 }}>Loading runs...</div>;
  }

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      {/* 🔹 HEADER */}
      <h2 style={{ marginBottom: 16 }}>Work</h2>

      {/* 🔹 FILTERS */}
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        {["all", "running", "completed", "failed", "queued"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: "6px 12px",
              borderRadius: 20,
              border: "1px solid #ddd",
              background: filter === f ? "#111" : "#fff",
              color: filter === f ? "#fff" : "#333",
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {/* 🔹 SEARCH */}
      <input
        placeholder="Search by project..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{
          width: 300,
          padding: 8,
          borderRadius: 6,
          border: "1px solid #ddd",
          marginBottom: 16,
        }}
      />

      {/* 🔹 TABLE */}
      <div className="card">
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", fontSize: 12, color: "gray" }}>
              <th style={th}>Run ID</th>
              <th style={th}>Project</th>
              <th style={th}>Type</th>
              <th style={th}>Status</th>
              <th style={th}>Passed</th>
              <th style={th}>Failed</th>
              <th style={th}>Started</th>
            </tr>
          </thead>

          <tbody>
            {filteredRuns.length === 0 ? (
              <tr>
                <td colSpan="7" style={{ padding: 20, textAlign: "center" }}>
                  No runs found
                </td>
              </tr>
            ) : (
              filteredRuns.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => navigate(`/runs/${r.id}`)}
                  style={{
                    borderTop: "1px solid #eee",
                    cursor: "pointer",
                  }}
                >
                  <td style={td}>{shortId(r.id)}</td>
                  <td style={td}>{r.projectName || "—"}</td>
                  <td style={td}>{r.type || "—"}</td>
                  <td style={td}>
                    <StatusBadge status={r.status} />
                  </td>
                  <td style={td}>{r.passed ?? "—"}</td>
                  <td style={td}>{r.failed ?? "—"}</td>
                  <td style={td}>
                    {formatDate(r.startedAt || r.createdAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* 🔹 HELPERS */

function shortId(id) {
  return id ? id.slice(0, 8) + "..." : "—";
}

function formatDate(date) {
  return date ? new Date(date).toLocaleString() : "—";
}

/* 🔹 STYLES */

const th = {
  padding: "12px 14px",
  fontWeight: 500,
};

const td = {
  padding: "14px",
  fontSize: 14,
};

/* 🔹 STATUS BADGE */

function StatusBadge({ status }) {
  const colors = {
    completed: "#16a34a",
    running: "#2563eb",
    failed: "#dc2626",
    queued: "#f59e0b",
  };

  return (
    <span style={{ color: colors[status] || "gray", fontWeight: 500 }}>
      {status}
    </span>
  );
}