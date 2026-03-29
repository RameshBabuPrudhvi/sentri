import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Globe, Cpu, Key, ChevronRight, CheckCircle2,
  XCircle, Clock, AlertCircle, Layers,
  Link2, RefreshCw, Shield,
} from "lucide-react";
import { api } from "../api";

function fmtDate(iso) {
  if (!iso) return "Never";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 3600000)  return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

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
  const [projects, setProjects]   = useState([]);
  const [config, setConfig]       = useState(null);
  const [crawlData, setCrawlData] = useState({});
  const [loading, setLoading]     = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    async function load() {
      try {
        const [projs, cfg] = await Promise.all([
          api.getProjects(),
          api.getConfig().catch(() => null),
        ]);
        setProjects(projs);
        setConfig(cfg);

        // Load last crawl info per project
        const crawls = {};
        await Promise.all(projs.map(async p => {
          const runs = await api.getRuns(p.id).catch(() => []);
          const lastCrawl = runs
            .filter(r => r.type === "crawl")
            .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0] || null;
          const tests = await api.getTests(p.id).catch(() => []);
          crawls[p.id] = { lastCrawl, tests };
        }));
        setCrawlData(crawls);
      } catch (err) {
        console.error("Context load error:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

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

      {/* AI Provider card */}
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
            {!config.hasProvider && (
              <div style={{ marginTop: 14 }}>
                <button className="btn btn-primary btn-sm" onClick={() => navigate("/settings")}>
                  <Key size={13} /> Configure API Key
                </button>
              </div>
            )}
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
          <div style={{ padding: "20px 0", textAlign: "center", color: "var(--text3)", fontSize: "0.85rem" }}>
            No applications registered yet.{" "}
            <button className="btn btn-ghost btn-xs" onClick={() => navigate("/projects/new")}>Add one</button>
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
                      Last crawl: <strong style={{ color: "var(--text2)" }}>{fmtDate(crawl?.startedAt)}</strong>
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

      {/* Supported providers reference */}
      {config?.supportedProviders?.length > 0 && (
        <div className="card" style={{ padding: 24 }}>
          <SectionHeader
            icon={<Key size={15} color="var(--amber)" />}
            title="Supported AI Providers"
            sub="Configure one of these providers in Settings to enable AI test generation"
          />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
            {config.supportedProviders.map(prov => {
              const isActive = config.hasProvider && config.providerName === prov.name;
              return (
                <div key={prov.id} style={{
                  padding: "14px 16px", borderRadius: 10,
                  background: isActive ? "var(--accent-bg)" : "var(--bg2)",
                  border: `1px solid ${isActive ? "rgba(91,110,245,0.3)" : "var(--border)"}`,
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{prov.name}</span>
                    {isActive && <span className="badge badge-accent" style={{ fontSize: "0.65rem" }}>Active</span>}
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text3)", marginBottom: 8 }}>
                    {prov.model}
                  </div>
                  <a
                    href={prov.docsUrl} target="_blank" rel="noreferrer"
                    style={{ fontSize: "0.72rem", color: "var(--accent)", display: "flex", alignItems: "center", gap: 4 }}
                  >
                    <Link2 size={10} /> Get API key
                  </a>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}