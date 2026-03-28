import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Plus, RefreshCw, CheckCircle2, XCircle, Clock, Filter } from "lucide-react";
import { api } from "../api.js";

const STATUS_FILTERS = ["All", "Passing", "Failing", "Not Run"];

function AgentTag({ type = "TA" }) {
  const s = { QA: "avatar-qa", TA: "avatar-ta", EX: "avatar-ex" };
  return <div className={`avatar ${s[type]}`}>{type}</div>;
}

function StatusBadge({ result }) {
  if (!result) return <span className="badge badge-gray"><Clock size={10} /> Not run</span>;
  if (result === "passed") return <span className="badge badge-green"><CheckCircle2 size={10} /> Passing</span>;
  if (result === "failed") return <span className="badge badge-red"><XCircle size={10} /> Failing</span>;
  return <span className="badge badge-amber">{result}</span>;
}

export default function Projects() {
  const [projects, setProjects] = useState([]);
  const [tests, setTests] = useState([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    api.getProjects().then(async (projs) => {
      setProjects(projs);
      const all = await Promise.all(projs.map(p => api.getTests(p.id).catch(() => [])));
      setTests(all.flat());
    }).finally(() => setLoading(false));
  }, []);

  const filtered = tests.filter(t => {
    const matchSearch = !search || t.name?.toLowerCase().includes(search.toLowerCase()) || t.description?.toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === "All"
      || (filter === "Passing" && t.lastResult === "passed")
      || (filter === "Failing" && t.lastResult === "failed")
      || (filter === "Not Run" && !t.lastResult);
    return matchSearch && matchFilter;
  });

  // Get project name for a test
  const projMap = Object.fromEntries(projects.map(p => [p.id, p]));

  return (
    <div className="fade-in">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>Tests</h1>
        <button className="btn btn-primary btn-sm" onClick={() => navigate("/projects/new")}>
          <Plus size={14} /> New Project
        </button>
      </div>

      {/* Quick Actions */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
        {[
          { icon: "✦", title: "Create Tests", desc: "Create a new test case for your application", color: "var(--accent-bg)", iconColor: "var(--accent)", action: () => navigate("/projects/new") },
          { icon: "▶", title: "Run Tests",    desc: "Execute regression tests from your test suite", color: "var(--green-bg)", iconColor: "var(--green)", action: () => {} },
          { icon: "⚑", title: "Review and Fix Tests", desc: "Refine and manage your draft and failing tests", color: "var(--amber-bg)", iconColor: "var(--amber)", action: () => {} },
        ].map((a, i) => (
          <div key={i} className="card" style={{ padding: 18, cursor: "pointer", transition: "box-shadow 0.15s" }}
            onClick={a.action} onMouseEnter={e => e.currentTarget.style.boxShadow = "var(--shadow)"}
            onMouseLeave={e => e.currentTarget.style.boxShadow = ""}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, background: a.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0, color: a.iconColor }}>
                {a.icon}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: 3 }}>{a.title}</div>
                <div style={{ fontSize: "0.78rem", color: "var(--text2)", lineHeight: 1.5 }}>{a.desc}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tests table */}
      <div className="card">
        {/* Table toolbar */}
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 600, fontSize: "0.9rem", flex: "0 0 auto" }}>
            Regression Tests ({filtered.length})
          </div>
          <div style={{ flex: 1, minWidth: 200, position: "relative" }}>
            <Search size={13} color="var(--text3)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)" }} />
            <input className="input" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search tests..." style={{ paddingLeft: 28, height: 32, fontSize: "0.82rem" }} />
          </div>
          <div style={{ display: "flex", gap: 4, background: "var(--bg2)", padding: 3, borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
            {STATUS_FILTERS.map(f => (
              <button key={f} className="btn btn-xs" onClick={() => setFilter(f)} style={{
                background: filter === f ? "#fff" : "transparent",
                color: filter === f ? "var(--text)" : "var(--text3)",
                border: filter === f ? "1px solid var(--border)" : "1px solid transparent",
                boxShadow: filter === f ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
              }}>{f}</button>
            ))}
          </div>
          <button className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}>
            <Filter size={13} /> Functional Area
          </button>
        </div>

        {loading ? (
          <div style={{ padding: 24 }}>
            {[...Array(5)].map((_, i) => <div key={i} className="skeleton" style={{ height: 44, marginBottom: 8, borderRadius: 8 }} />)}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: "60px 24px", textAlign: "center", color: "var(--text2)" }}>
            {tests.length === 0
              ? "No tests yet — crawl a project to generate tests"
              : "No tests match your search"}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Test Name</th>
                <th>Status</th>
                <th>Last Run</th>
                <th>Project</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t.id} style={{ cursor: "pointer" }}
                  onClick={() => navigate(`/projects/${t.projectId}`)}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <AgentTag type="TA" />
                      <div>
                        <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>{t.name}</div>
                        {t.description && <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: 1, maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.description}</div>}
                      </div>
                    </div>
                  </td>
                  <td><StatusBadge result={t.lastResult} /></td>
                  <td>
                    <span style={{ fontSize: "0.8rem", color: "var(--text2)" }}>
                      {t.lastRunAt ? new Date(t.lastRunAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                    </span>
                  </td>
                  <td>
                    {projMap[t.projectId] && (
                      <span className="badge badge-gray">{projMap[t.projectId].name}</span>
                    )}
                  </td>
                  <td>
                    {t.isJourneyTest && <span className="badge badge-purple">Journey</span>}
                    {t.priority === "high" && <span className="badge badge-red" style={{ marginLeft: 4 }}>High</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
