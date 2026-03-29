import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus, Globe, Play, Search, ExternalLink,
  CheckCircle2, XCircle, Clock, RefreshCw,
  FlaskConical, AlertCircle, ChevronRight,
} from "lucide-react";
import { api } from "../api";

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 3600000)  return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function StatusDot({ status }) {
  const colors = {
    passed: "var(--green)", failed: "var(--red)",
    running: "var(--blue)", idle: "var(--text3)",
  };
  return (
    <span style={{
      width: 8, height: 8, borderRadius: "50%",
      background: colors[status] || colors.idle,
      display: "inline-block", flexShrink: 0,
      ...(status === "running" ? { animation: "pulse 1.5s infinite" } : {}),
    }} />
  );
}

function PassRateBar({ rate }) {
  if (rate == null) return <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>No runs</span>;
  const color = rate >= 80 ? "var(--green)" : rate >= 50 ? "var(--amber)" : "var(--red)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 5, borderRadius: 3, background: "var(--bg3)", overflow: "hidden", minWidth: 60 }}>
        <div style={{ width: `${rate}%`, height: "100%", background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: "0.75rem", fontWeight: 600, color, minWidth: 28 }}>{rate}%</span>
    </div>
  );
}

export default function Applications() {
  const [projects, setProjects]   = useState([]);
  const [projectStats, setStats]  = useState({});
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    async function load() {
      try {
        const projs = await api.getProjects();
        setProjects(projs);

        // Load tests + runs per project in parallel for stats
        const statsMap = {};
        await Promise.all(projs.map(async p => {
          const [tests, runs] = await Promise.all([
            api.getTests(p.id).catch(() => []),
            api.getRuns(p.id).catch(() => []),
          ]);
          const testRuns = runs.filter(r => r.type === "test_run");
          const lastRun = testRuns[0] || null;
          const completedRuns = testRuns.filter(r => r.status === "completed");
          const passRate = completedRuns.length
            ? Math.round(
                (completedRuns.reduce((s, r) => s + (r.passed || 0), 0) /
                 completedRuns.reduce((s, r) => s + (r.total || 1), 0)) * 100
              )
            : null;
          const lastCrawl = runs.filter(r => r.type === "crawl")[0] || null;
          statsMap[p.id] = {
            totalTests:   tests.length,
            approved:     tests.filter(t => t.reviewStatus === "approved").length,
            draft:        tests.filter(t => t.reviewStatus === "draft").length,
            passRate,
            lastRun,
            lastCrawl,
            activeRun:    testRuns.find(r => r.status === "running") || null,
          };
        }));
        setStats(statsMap);
      } catch (err) {
        console.error("Applications load error:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const filtered = projects.filter(p =>
    !search.trim() || p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.url || "").toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      {[80, ...Array(3).fill(130)].map((h, i) => (
        <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 12 }} />
      ))}
    </div>
  );

  return (
    <div className="fade-in" style={{ maxWidth: 900, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: 3 }}>Applications</h1>
          <p style={{ fontSize: "0.82rem", color: "var(--text2)" }}>
            Manage your applications under test and their health at a glance
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => navigate("/projects/new")}>
          <Plus size={14} /> New Application
        </button>
      </div>

      {/* Search */}
      {projects.length > 0 && (
        <div style={{ position: "relative", maxWidth: 340, marginBottom: 16 }}>
          <Search size={13} color="var(--text3)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)" }} />
          <input
            className="input"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search applications..."
            style={{ paddingLeft: 28, height: 34, fontSize: "0.82rem" }}
          />
        </div>
      )}

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="card" style={{ padding: "60px 40px", textAlign: "center" }}>
          <Globe size={36} color="var(--text3)" style={{ marginBottom: 14 }} />
          <div style={{ fontWeight: 600, fontSize: "1.05rem", marginBottom: 6 }}>
            {projects.length === 0 ? "No applications yet" : "No results"}
          </div>
          <div style={{ fontSize: "0.85rem", color: "var(--text2)", marginBottom: 20 }}>
            {projects.length === 0
              ? "Add your first application to start crawling and generating tests."
              : "Try a different search."}
          </div>
          {projects.length === 0 && (
            <button className="btn btn-primary btn-sm" onClick={() => navigate("/projects/new")}>
              <Plus size={13} /> Add Application
            </button>
          )}
        </div>
      )}

      {/* Application cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.map(p => {
          const s = projectStats[p.id] || {};
          const status = s.activeRun ? "running"
            : s.lastRun?.status === "completed" ? "passed"
            : s.lastRun?.status === "failed" ? "failed"
            : "idle";

          return (
            <div
              key={p.id}
              className="card"
              style={{ padding: "18px 22px", cursor: "pointer", transition: "box-shadow 0.15s" }}
              onClick={() => navigate(`/projects/${p.id}`)}
              onMouseEnter={e => e.currentTarget.style.boxShadow = "var(--shadow)"}
              onMouseLeave={e => e.currentTarget.style.boxShadow = ""}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>

                {/* Icon */}
                <div style={{
                  width: 42, height: 42, borderRadius: 10,
                  background: "var(--accent-bg)", border: "1px solid rgba(91,110,245,0.2)",
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                  <Globe size={18} color="var(--accent)" />
                </div>

                {/* Main info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <StatusDot status={status} />
                    <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>{p.name}</span>
                    {s.activeRun && (
                      <span className="badge badge-blue" style={{ gap: 4 }}>
                        <RefreshCw size={9} className="spin" /> Running
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text3)", fontFamily: "var(--font-mono)", marginBottom: 12 }}>
                    {p.url}
                    <ExternalLink size={10} style={{ marginLeft: 4, verticalAlign: "middle" }} />
                  </div>

                  {/* Stats row */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1.6fr", gap: 16 }}>
                    <div>
                      <div style={{ fontSize: "0.7rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>Tests</div>
                      <div style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--text)" }}>
                        {s.totalTests ?? 0}
                        {s.draft > 0 && (
                          <span style={{ fontSize: "0.72rem", color: "var(--amber)", fontWeight: 500, marginLeft: 5 }}>
                            {s.draft} draft
                          </span>
                        )}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: "0.7rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>Approved</div>
                      <div style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--green)" }}>
                        {s.approved ?? 0}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: "0.7rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>Last Run</div>
                      <div style={{ fontSize: "0.82rem", color: "var(--text2)" }}>
                        {fmtDate(s.lastRun?.startedAt) || "Never"}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: "0.7rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>Pass Rate</div>
                      <PassRateBar rate={s.passRate} />
                    </div>
                  </div>
                </div>

                {/* Quick actions */}
                <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }} onClick={e => e.stopPropagation()}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => navigate(`/projects/${p.id}`)}
                    title="View project"
                  >
                    <FlaskConical size={13} /> Tests
                  </button>
                  <ChevronRight size={16} color="var(--text3)" style={{ marginLeft: 4 }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}