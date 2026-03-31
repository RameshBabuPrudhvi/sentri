import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Globe, Cpu, ChevronRight, CheckCircle2,
  XCircle, Settings as SettingsIcon,
  RefreshCw, Shield,
} from "lucide-react";
import { api } from "../api";
import { fmtRelativeDate } from "../utils/formatters";
import useProjectData from "../hooks/useProjectData";

function SectionHeader({ icon, title, sub }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
      <div style={{
        width: 32, height: 32, borderRadius: 8, background: "var(--bg2)",
        border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {icon}
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>{title}</div>
        {sub && <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 1 }}>{sub}</div>}
      </div>
    </div>
  );
}

function InfoRow({ label, children }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ fontSize: "0.8rem", color: "var(--text3)", fontWeight: 500, minWidth: 140 }}>{label}</span>
      <span style={{ fontSize: "0.82rem", color: "var(--text)", textAlign: "right", flex: 1 }}>{children}</span>
    </div>
  );
}

export default function Context() {
  // FIX #10: useProjectData batches all project/run/test fetches in one pass (no N+1)
  const { projects, allTests, allRuns, loading } = useProjectData();
  const [config, setConfig] = React.useState(null);
  const navigate = useNavigate();

  React.useEffect(() => {
    api.getConfig().then(setConfig).catch(() => null);
  }, []);

  // Build crawl summary per project from already-fetched allRuns and allTests
  const crawlData = useMemo(() => {
    const map = {};
    projects.forEach(p => {
      const projectRuns = allRuns.filter(r => r.projectId === p.id);
      const lastCrawl = projectRuns
        .filter(r => r.type === "crawl")
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0] || null;
      const tests = allTests.filter(t => t.projectId === p.id);
      map[p.id] = { lastCrawl, tests };
    });
    return map;
  }, [projects, allRuns, allTests]);

  if (loading) return (
    <div style={{ maxWidth: 880, margin: "0 auto" }}>
      {[60, 200, 200, 180].map((h, i) => (
        <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 14 }} />
      ))}
    </div>
  );

  const hasProjects = projects.length > 0;

  return (
    <div className="fade-in" style={{ maxWidth: 880, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: 4 }}>Context</h1>
        <p style={{ fontSize: "0.82rem", color: "var(--text2)" }}>
          Environment configuration, AI provider status, and crawl context for your applications
        </p>
      </div>

      {/* AI Provider — compact status with link to Settings */}
      <div className="card" style={{ padding: 24, marginBottom: 16 }}>
        <SectionHeader
          icon={<Cpu size={15} color="var(--accent)" />}
          title="AI Provider"
          sub="Active model used for test generation and Playwright code synthesis"
        />
        {config ? (
          <div>
            <InfoRow label="Status">
              {config.hasProvider ? (
                <span className="badge badge-green"><CheckCircle2 size={10} /> Connected</span>
              ) : (
                <span className="badge badge-red"><XCircle size={10} /> Not configured</span>
              )}
            </InfoRow>
            {config.hasProvider && (
              <>
                <InfoRow label="Provider">
                  <span style={{ fontWeight: 500 }}>{config.providerName || "—"}</span>
                </InfoRow>
                {config.model && (
                  <InfoRow label="Model">
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--accent)" }}>
                      {config.model}
                    </span>
                  </InfoRow>
                )}
              </>
            )}
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => navigate("/settings")}>
                <SettingsIcon size={13} /> {config.hasProvider ? "Manage in Settings" : "Configure API Key"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ color: "var(--text3)", fontSize: "0.85rem" }}>Could not load provider config.</div>
        )}
      </div>

      {/* Applications context */}
      <div className="card" style={{ padding: 24, marginBottom: 16 }}>
        <SectionHeader
          icon={<Globe size={15} color="var(--purple)" />}
          title="Application Environments"
          sub={`${projects.length} application${projects.length !== 1 ? "s" : ""} registered`}
        />

        {!hasProjects ? (
          // Fix #17: proper empty state card with clear CTA
          <div style={{ padding: "48px 32px", textAlign: "center", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)" }}>
            <Globe size={32} color="var(--text3)" style={{ marginBottom: 14 }} />
            <div style={{ fontWeight: 600, fontSize: "1rem", marginBottom: 6 }}>No applications registered</div>
            <div style={{ fontSize: "0.85rem", color: "var(--text2)", marginBottom: 20, maxWidth: 340, margin: "0 auto 20px" }}>
              Add a project to see crawl context, test counts, and AI configuration for each application.
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => navigate("/projects/new")}>
              Add First Project
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {projects.map(p => {
              const cd = crawlData[p.id] || {};
              const crawl = cd.lastCrawl;
              const tests = cd.tests || [];
              return (
                <div
                  key={p.id}
                  style={{
                    padding: "16px 18px", background: "var(--bg2)",
                    borderRadius: 10, border: "1px solid var(--border)",
                    cursor: "pointer",
                  }}
                  onClick={() => navigate(`/projects/${p.id}`)}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{
                        width: 28, height: 28, borderRadius: 7, background: "var(--purple-bg)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        <Globe size={13} color="var(--purple)" />
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: "0.88rem" }}>{p.name}</div>
                        <a
                          href={p.url} target="_blank" rel="noreferrer"
                          onClick={e => e.stopPropagation()}
                          style={{ fontSize: "0.72rem", fontFamily: "var(--font-mono)", color: "var(--accent)" }}
                        >
                          {p.url}
                        </a>
                      </div>
                    </div>
                    <ChevronRight size={14} color="var(--text3)" />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
                    {[
                      { label: "Total Tests",  value: tests.length },
                      { label: "Approved",     value: tests.filter(t => t.reviewStatus === "approved").length },
                      { label: "Draft",        value: tests.filter(t => t.reviewStatus === "draft").length },
                      { label: "Pages Found",  value: crawl?.pagesFound ?? "—" },
                    ].map((item, i) => (
                      <div key={i}>
                        <div style={{ fontSize: "0.68rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>
                          {item.label}
                        </div>
                        <div style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)" }}>{item.value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Crawl row */}
                  <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 }}>
                    <RefreshCw size={11} color="var(--text3)" />
                    <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>
                      Last crawl: <strong style={{ color: "var(--text2)" }}>{fmtRelativeDate(crawl?.startedAt, "Never")}</strong>
                    </span>
                    {crawl && (
                      <span className={`badge ${crawl.status === "completed" ? "badge-green" : crawl.status === "failed" ? "badge-red" : "badge-amber"}`}>
                        {crawl.status}
                      </span>
                    )}
                    {p.credentials && (
                      <span className="badge badge-gray" style={{ marginLeft: "auto" }}>
                        <Shield size={9} /> Auth configured
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}