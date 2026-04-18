import React, { useState, useEffect } from "react";
import { Map, List } from "lucide-react";
import { useNavigate } from "react-router-dom";
import SiteGraph from "./SiteGraph.jsx";
import useLogBuffer from "../../hooks/useLogBuffer.js";
import PipelineCard from "../run/PipelineCard.jsx";
import GenerationSuccessBanner from "../generate/GenerationSuccessBanner.jsx";
import ActivityLogCard from "../run/ActivityLogCard.jsx";
import RunSidebar from "../run/RunSidebar.jsx";
import { api } from "../../api.js";

// Each stage maps to a 1-based step index set authoritatively by the
// backend via run.currentStep. No fragile log-string scraping needed.
const PIPELINE_STAGES = [
  { label: "Crawl & Snapshot Pages",      icon: "🔍", step: 1 },
  { label: "Filter Elements",             icon: "🧹", step: 2 },
  { label: "Classify Intents & Journeys", icon: "🧠", step: 3 },
  { label: "Generate Tests via AI",       icon: "⚡", step: 4 },
  { label: "Deduplicate Tests",           icon: "🚫", step: 5 },
  { label: "Enhance Assertions",          icon: "✨", step: 6 },
  { label: "Validate Tests",             icon: "✅", step: 7 },
  { label: "Done",                        icon: "🎉", step: 8 },
];

export default function CrawlView({ run, isRunning }) {
  const navigate = useNavigate();
  const [graphView, setGraphView] = React.useState("graph"); // "graph" | "list"
  const [selectedPage, setSelectedPage] = React.useState(null);

  // DIF-011: Fetch testsByUrl from dashboard API for coverage heatmap.
  // Only fetch when the crawl is NOT running (avoids hitting the heavy
  // dashboard endpoint on every status toggle). Re-fetches when a run
  // finishes so the heatmap reflects newly generated tests.
  const [testsByUrl, setTestsByUrl] = useState(null);
  useEffect(() => {
    if (isRunning) return; // skip while crawl is active
    api.getDashboard()
      .then(d => { if (d?.testsByUrl) setTestsByUrl(d.testsByUrl); })
      .catch(() => { /* non-fatal — heatmap falls back to legacy mode */ });
  }, [isRunning]);

  const logs = useLogBuffer(run);
  const ps = run?.pipelineStats || {};

  // Derive the page currently being crawled from the latest log entry
  // Log lines look like: "Crawling https://example.com/page" or "✓ https://..."
  const activePage = React.useMemo(() => {
    for (let i = logs.length - 1; i >= 0; i--) {
      const m = logs[i].match(/https?:\/\/[^\s)]+/);
      if (m) return m[0];
    }
    return null;
  }, [logs]);

  // Pages for the site graph — prefer run.snapshots, fall back to run.pages
  const graphPages = React.useMemo(() => {
    const raw = run?.pages || run?.snapshots || [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "object") return Object.values(raw);
    return [];
  }, [run?.pages, run?.snapshots]);

  const stats = [
    {
      label: "Pages Found",
      val: run?.pagesFound ?? ps.pagesFound,
      color: "var(--accent)",
    },
    {
      label: "Tests Generated",
      val: run?.testsGenerated ?? ps.rawTestsGenerated,
      color: "var(--green)",
    },
    {
      label: "Duplicates Removed",
      val: ps.duplicatesRemoved,
      color: "var(--amber)",
    },
    {
      label: "Journeys Detected",
      val: ps.journeysDetected,
      color: "#a855f7",
    },
    {
      label: "Assertions Enhanced",
      val: ps.assertionsEnhanced,
      color: "var(--blue)",
    },
    {
      label: "Validation Rejected",
      val: ps.validationRejected,
      color: "var(--red)",
    },
    {
      label: "Avg Quality Score",
      val:
        ps.averageQuality != null ? `${ps.averageQuality}/100` : null,
      color:
        (ps.averageQuality || 0) >= 60 ? "var(--green)" : "var(--amber)",
    },
  ];

  return (
    <div
      className="run-grid"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 300px",
        gap: 16,
        alignItems: "start",
      }}
    >
      {/* ── LEFT: Pipeline + Logs ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>

        <PipelineCard
          stages={PIPELINE_STAGES}
          currentStep={run?.currentStep ?? 0}
          status={run?.status}
          isRunning={isRunning}
        />

        <GenerationSuccessBanner run={run} isRunning={isRunning} />

        {/* Site map card */}
        <div className="card" style={{ overflow: "hidden", minWidth: 0 }}>
          {/* Header with graph/list toggle */}
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 700, fontSize: "0.875rem", flex: 1 }}>Site Map</span>
            <div style={{ display: "flex", gap: 2, background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 7, padding: 2 }}>
              {[{ id: "graph", icon: <Map size={12} />, label: "Graph" }, { id: "list", icon: <List size={12} />, label: "List" }].map(({ id, icon, label }) => (
                <button key={id} onClick={() => setGraphView(id)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: "0.7rem", fontWeight: 600, background: graphView === id ? "var(--surface)" : "transparent", color: graphView === id ? "var(--accent)" : "var(--text3)", boxShadow: graphView === id ? "0 1px 3px rgba(0,0,0,0.08)" : "none", transition: "all 0.12s" }}>
                  {icon}{label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ padding: 14 }}>
            {graphView === "graph" ? (
              <SiteGraph
                pages={graphPages}
                activePage={activePage}
                isRunning={isRunning}
                onNodeClick={(page) => setSelectedPage(p => p?.url === page.url ? null : page)}
                testsByUrl={testsByUrl}
              />
            ) : (
              /* List view */
              <div style={{ maxHeight: 300, overflowY: "auto" }}>
                {graphPages.length === 0 ? (
                  <div style={{ padding: "24px 0", textAlign: "center", color: "var(--text3)", fontSize: "0.78rem" }}>
                    {isRunning ? "Crawling…" : "No pages found"}
                  </div>
                ) : graphPages.map((p, i) => (
                  <div key={i} onClick={() => setSelectedPage(prev => prev?.url === p.url ? null : p)}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: i < graphPages.length - 1 ? "1px solid var(--border)" : "none", cursor: "pointer" }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: p.error ? "var(--red)" : p.testCount > 0 ? "var(--green)" : "var(--text3)" }} />
                    <span style={{ fontSize: "0.75rem", color: "var(--text2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.url}
                    </span>
                    {p.testCount > 0 && <span style={{ fontSize: "0.65rem", color: "var(--green)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>{p.testCount} tests</span>}
                  </div>
                ))}
              </div>
            )}

            {/* Node detail panel — shown when a node is clicked */}
            {selectedPage && (
              <div style={{ marginTop: 12, padding: "12px 14px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text)", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {selectedPage.title || "Page"}
                    </div>
                    <div style={{ fontSize: "0.68rem", color: "var(--text3)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {selectedPage.url}
                    </div>
                  </div>
                  <button onClick={() => setSelectedPage(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", fontSize: 16, lineHeight: 1, padding: 0, flexShrink: 0 }}>×</button>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  {selectedPage.testCount > 0 && (
                    <span className="badge badge-green" style={{ fontSize: "0.65rem" }}>{selectedPage.testCount} tests</span>
                  )}
                  {selectedPage.error && (
                    <span className="badge badge-red" style={{ fontSize: "0.65rem" }}>Crawl error</span>
                  )}
                  {selectedPage.dominantIntent && (
                    <span className="badge badge-blue" style={{ fontSize: "0.65rem" }}>{selectedPage.dominantIntent}</span>
                  )}
                  <button
                    onClick={() => navigate(`/projects/${run?.projectId || ""}/generate?url=${encodeURIComponent(selectedPage.url)}&name=${encodeURIComponent(selectedPage.title || selectedPage.url)}`)}
                    style={{ marginLeft: "auto", fontSize: "0.7rem", padding: "3px 10px", borderRadius: 5, border: "1px solid var(--accent)", background: "var(--accent-bg)", color: "var(--accent)", cursor: "pointer", fontWeight: 600 }}>
                    + Generate test
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <ActivityLogCard logs={logs} isRunning={isRunning} emptyLabel="Starting crawl…" />
      </div>

      {/* ── RIGHT: Stats + Run Info ── */}
      <RunSidebar stats={stats} run={run} isRunning={isRunning} failLabel="Crawl failed — check logs for details." />
    </div>
  );
}