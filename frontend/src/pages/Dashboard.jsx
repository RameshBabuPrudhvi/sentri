import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { ArrowRight, CheckCircle2, FileText } from "lucide-react";
import { api } from "../api.js";

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

const RUN_TYPE_META = {
  crawl:    { label: "Crawl & Generate", avatar: "QA", avatarClass: "avatar-qa" },
  generate: { label: "AI Generate",      avatar: "QA", avatarClass: "avatar-qa" },
  run:      { label: "Test Run",         avatar: "TA", avatarClass: "avatar-ta" },
  test_run: { label: "Test Run",         avatar: "TA", avatarClass: "avatar-ta" },
};

function AgentTag({ type }) {
  const meta = RUN_TYPE_META[type] || RUN_TYPE_META["run"];
  return <div className={`avatar ${meta.avatarClass}`}>{meta.avatar}</div>;
}

function RunningBadge() {
  return (
    <span className="badge badge-blue" style={{ gap: 5 }}>
      <span className="spin" style={{ width: 8, height: 8, border: "1.5px solid #2563eb", borderTopColor: "transparent", borderRadius: "50%", display: "inline-block" }} />
      Running
    </span>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([api.getDashboard(), api.getProjects()])
      .then(([d]) => {
        setData(d);
        setRuns((d.recentRuns || []).slice(0, 6));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const chartData = (data?.history || []).map((r, i) => ({ name: `#${i + 1}`, passed: r.passed, failed: r.failed }));

  if (loading) return (
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      {[120, 200, 300].map((h, i) => <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 16 }} />)}
    </div>
  );

  const isEmpty = !data?.totalProjects && !data?.totalTests && !data?.totalRuns;

  return (
    <div className="fade-in" style={{ maxWidth: 860, margin: "0 auto" }}>

      {/* Greeting */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: "1.8rem", fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
          {greeting()}!
        </h1>
        <p style={{ color: "var(--text2)", fontSize: "0.9rem" }}>
          Here's your real-time overview of the testing environment, including system health, key metrics, and what your agents are up to right now.
        </p>
      </div>

      {/* Fix #8: first-time onboarding banner instead of zeros */}
      {isEmpty ? (
        <div className="card" style={{ padding: "48px 40px", textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: "2.5rem", marginBottom: 14 }}>🚀</div>
          <div style={{ fontWeight: 700, fontSize: "1.15rem", marginBottom: 8 }}>Welcome to Sentri!</div>
          <div style={{ color: "var(--text2)", fontSize: "0.9rem", marginBottom: 24, maxWidth: 420, margin: "0 auto 24px" }}>
            Create your first project to start crawling your web app and AI-generating tests automatically.
          </div>
          <button className="btn btn-primary" onClick={() => navigate("/projects/new")}>
            Create First Project
          </button>
        </div>
      ) : (
        <>
          {/* System Summary */}
          <div className="card" style={{ padding: 24, marginBottom: 16 }}>
            <div style={{ fontWeight: 600, fontSize: "1rem", marginBottom: 20 }}>System Summary</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div style={{ display: "flex", gap: 12, padding: 16, background: "var(--bg2)", borderRadius: 10, border: "1px solid var(--border)" }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--green-bg)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <CheckCircle2 size={18} color="var(--green)" />
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: 3 }}>Upcoming work</div>
                  <div style={{ fontSize: "0.82rem", color: "var(--text2)" }}>
                    You have <strong>{data?.totalTests ?? 0} tests</strong> active or scheduled.
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 12, padding: 16, background: "var(--bg2)", borderRadius: 10, border: "1px solid var(--border)" }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--blue-bg)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <FileText size={18} color="var(--blue)" />
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: 3 }}>Daily Report</div>
                  <div style={{ fontSize: "0.82rem", color: "var(--text2)" }}>
                    Pass rate: <strong style={{ color: data?.passRate >= 80 ? "var(--green)" : "var(--amber)" }}>{data?.passRate != null ? `${data.passRate}%` : "No runs yet"}</strong>
                    {data?.totalRuns > 0 && <span> across {data.totalRuns} runs</span>}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Stats row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
            {[
              { label: "Projects",  value: data?.totalProjects ?? 0, color: "var(--accent)"  },
              { label: "Tests",     value: data?.totalTests ?? 0,    color: "var(--blue)"    },
              { label: "Runs",      value: data?.totalRuns ?? 0,     color: "var(--purple)"  },
              { label: "Pass Rate", value: data?.passRate != null ? `${data.passRate}%` : "—", color: data?.passRate >= 80 ? "var(--green)" : "var(--amber)" },
            ].map((s, i) => (
              <div key={i} className="card" style={{ padding: "16px 20px" }}>
                <div style={{ fontSize: "0.73rem", fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>{s.label}</div>
                <div style={{ fontSize: "1.8rem", fontWeight: 700, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* Fix #18: show chart even with 1 run */}
          {chartData.length >= 1 && (
            <div className="card" style={{ padding: 24, marginBottom: 16 }}>
              <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: 16, color: "var(--text2)" }}>Run history</div>
              <ResponsiveContainer width="100%" height={140}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="gp" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#16a34a" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#16a34a" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gf" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#dc2626" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#dc2626" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--text3)" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "var(--text3)" }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--text)" }} />
                  <Area type="monotone" dataKey="passed" stroke="#16a34a" fill="url(#gp)" strokeWidth={2} />
                  <Area type="monotone" dataKey="failed" stroke="#dc2626" fill="url(#gf)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Recent Activity */}
          {runs.length > 0 && (
            <div className="card" style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "1rem" }}>Recent Activity</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text3)", marginTop: 2 }}>
                    {runs.filter(r => r.status === "running").length > 0
                      ? `${runs.filter(r => r.status === "running").length} task(s) in progress`
                      : "Latest runs across all projects"}
                  </div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate("/work")}>View all</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {runs.map((r) => {
                  const meta = RUN_TYPE_META[r.type] || RUN_TYPE_META["run"];
                  return (
                    <div key={r.id} style={{
                      display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
                      border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg2)",
                      cursor: "pointer", transition: "background 0.12s",
                    }} onClick={() => navigate(`/runs/${r.id}`)}>
                      <AgentTag type={r.type} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, fontSize: "0.875rem", marginBottom: 1 }}>{meta.label}</div>
                        <div style={{ fontSize: "0.78rem", color: "var(--text2)" }} className="truncate">
                          {r.projectName || `Project ${r.projectId?.slice(0, 8)}`}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        {r.status === "running"
                          ? <RunningBadge />
                          : r.status === "completed"
                          ? <span className="badge badge-green">✓ Completed</span>
                          : <span className="badge badge-red">✗ Failed</span>}
                        <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>
                          {new Date(r.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <ArrowRight size={14} color="var(--text3)" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
