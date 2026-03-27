import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Activity, Layers, CheckCircle, TrendingUp, ArrowRight, Plus } from "lucide-react";
import { api } from "../api.js";

function StatCard({ icon: Icon, label, value, sub, color = "var(--accent)" }) {
  return (
    <div className="card" style={{ position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, right: 0, width: 80, height: 80, background: color, opacity: 0.05, borderRadius: "0 0 0 80px" }} />
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: "0.75rem", fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--text3)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
          <div style={{ fontSize: "2.2rem", fontFamily: "var(--font-display)", fontWeight: 800, color: "var(--text)", lineHeight: 1 }}>{value ?? "—"}</div>
          {sub && <div style={{ fontSize: "0.78rem", color: "var(--text2)", marginTop: 6 }}>{sub}</div>}
        </div>
        <div style={{ width: 40, height: 40, background: color, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.85 }}>
          <Icon size={20} color="#fff" />
        </div>
      </div>
    </div>
  );
}

function statusBadge(s) {
  if (s === "completed") return <span className="badge badge-green">✓ Completed</span>;
  if (s === "running") return <span className="badge badge-blue pulse">● Running</span>;
  if (s === "failed") return <span className="badge badge-red">✗ Failed</span>;
  return <span className="badge badge-gray">{s}</span>;
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    api.getDashboard().then(setData).catch(console.error).finally(() => setLoading(false));
  }, []);

  const chartData = data?.recentRuns?.map((r, i) => ({
    name: `Run ${i + 1}`,
    passed: r.passed || 0,
    failed: r.failed || 0,
  })) || [];

  return (
    <div className="fade-in">
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.9rem", color: "var(--text)" }}>Dashboard</h1>
        <p style={{ color: "var(--text2)", marginTop: 6 }}>Autonomous QA overview across all projects</p>
      </div>

      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
          {[...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: 110, borderRadius: 16 }} />)}
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 28 }}>
            <StatCard icon={Layers} label="Projects" value={data?.totalProjects ?? 0} color="var(--purple)" />
            <StatCard icon={Activity} label="Test Cases" value={data?.totalTests ?? 0} color="var(--accent)" />
            <StatCard icon={CheckCircle} label="Total Runs" value={data?.totalRuns ?? 0} color="var(--green)" />
            <StatCard icon={TrendingUp} label="Pass Rate" value={data?.passRate != null ? `${data.passRate}%` : "—"} sub="from recent runs" color="var(--amber)" />
          </div>

          {chartData.length > 0 ? (
            <div className="card" style={{ marginBottom: 28 }}>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "0.9rem", color: "var(--text2)", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 20 }}>Recent Run History</div>
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="gp" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--green)" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="var(--green)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gf" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--red)" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="var(--red)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="name" stroke="var(--text3)" tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
                  <YAxis stroke="var(--text3)" tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
                  <Tooltip contentStyle={{ background: "var(--surface2)", border: "1px solid var(--border2)", borderRadius: 8, fontSize: 12 }} />
                  <Area type="monotone" dataKey="passed" stroke="var(--green)" fill="url(#gp)" strokeWidth={2} />
                  <Area type="monotone" dataKey="failed" stroke="var(--red)" fill="url(#gf)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : null}

          {data?.recentRuns?.length > 0 ? (
            <div className="card">
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "0.9rem", color: "var(--text2)", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 16 }}>Recent Runs</div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Run ID", "Status", "Passed", "Failed", "Started", ""].map((h, i) => (
                      <th key={i} style={{ textAlign: "left", padding: "8px 12px", fontSize: "0.72rem", fontFamily: "var(--font-display)", color: "var(--text3)", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.recentRuns.map((r) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "12px", fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text3)" }}>{r.id.slice(0, 8)}…</td>
                      <td style={{ padding: "12px" }}>{statusBadge(r.status)}</td>
                      <td style={{ padding: "12px", color: "var(--green)", fontWeight: 600, fontFamily: "var(--font-display)" }}>{r.passed ?? 0}</td>
                      <td style={{ padding: "12px", color: "var(--red)", fontWeight: 600, fontFamily: "var(--font-display)" }}>{r.failed ?? 0}</td>
                      <td style={{ padding: "12px", color: "var(--text2)", fontSize: "0.82rem" }}>{new Date(r.startedAt).toLocaleString()}</td>
                      <td style={{ padding: "12px" }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/runs/${r.id}`)}>
                          <ArrowRight size={13} /> View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card" style={{ textAlign: "center", padding: "60px 40px" }}>
              <div style={{ fontSize: "3rem", marginBottom: 16 }}>🐻</div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1.2rem", marginBottom: 8 }}>No runs yet</div>
              <div style={{ color: "var(--text2)", marginBottom: 24 }}>Create a project and start crawling to generate your first tests</div>
              <button className="btn btn-primary" onClick={() => navigate("/projects/new")}>
                <Plus size={16} /> Create First Project
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
