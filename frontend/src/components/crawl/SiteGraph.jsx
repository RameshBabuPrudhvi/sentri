import { useRef, useEffect, useState, useCallback } from "react";

/**
 * SiteGraph
 *
 * D3 force-directed graph showing crawled pages as nodes.
 * No external d3 import needed — uses the CDN build injected via a script tag,
 * OR falls back to a pure-CSS/SVG static layout when D3 is unavailable.
 *
 * Node colours (DIF-011: coverage heatmap when testsByUrl is provided):
 *   🟢 green fill   — page has ≥3 approved tests (high coverage)
 *   🟡 amber fill   — page has 1–2 approved tests (partial coverage)
 *   🔴 red fill     — page has 0 approved tests (no coverage)
 *   ⚫ gray fill    — crawled, no testsByUrl data available (legacy mode)
 *   🔴 red stroke   — crawl error on this page
 *   ⚪ white fill   — pending / not yet visited
 *   🔵 blue pulse   — currently being crawled (driven by isActivePage prop)
 *
 * Props:
 *   pages        — array of page objects from run.pages[]
 *   activePage   — URL string of page currently being crawled (from SSE log events)
 *   onNodeClick  — callback(page) when a node is clicked
 *   isRunning    — bool
 *   testsByUrl   — optional object { url: approvedTestCount } from dashboard API (DIF-011)
 */

// ── Colour helpers ─────────────────────────────────────────────────────────────

/**
 * DIF-011: Compute node colour based on coverage density.
 * When `testsByUrl` is provided, uses a heatmap: red (0) → amber (1–2) → green (3+).
 * Falls back to the legacy testCount-based colouring when testsByUrl is absent.
 *
 * @param {Object}      page
 * @param {Object|null} [testsByUrl] - { url: approvedTestCount }
 */
function nodeColor(page, testsByUrl) {
  if (page.error) return { fill: "#fee2e2", stroke: "#ef4444", strokeW: 2.5 };

  // DIF-011: Coverage heatmap mode
  if (testsByUrl) {
    const count = testsByUrl[page.url] || 0;
    if (count >= 3) return { fill: "#dcfce7", stroke: "#22c55e", strokeW: 2 };   // green — high coverage
    if (count >= 1) return { fill: "#fef3c7", stroke: "#f59e0b", strokeW: 2 };   // amber — partial
    if (page.visited) return { fill: "#fee2e2", stroke: "#ef4444", strokeW: 1.5 }; // red — no coverage
    return { fill: "#fff", stroke: "#cbd5e1", strokeW: 1 };
  }

  // Legacy mode (no testsByUrl data)
  if (page.testCount > 0) return { fill: "#dcfce7", stroke: "#22c55e", strokeW: 2 };
  if (page.visited)        return { fill: "#f1f5f9", stroke: "#94a3b8", strokeW: 1.5 };
  return                          { fill: "#fff",    stroke: "#cbd5e1", strokeW: 1 };
}

// ── URL → short label ─────────────────────────────────────────────────────────

function shortLabel(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/$/, "") || "/";
    return p.length > 18 ? "…" + p.slice(-16) : p;
  } catch {
    return url.slice(0, 20);
  }
}

// ── Infer edges from URL hierarchy ───────────────────────────────────────────

function inferEdges(pages) {
  const urls = new Set(pages.map(p => p.url));
  const edges = [];
  for (const page of pages) {
    try {
      const u = new URL(page.url);
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length > 0) {
        // Parent = one path segment shorter
        const parentPath = "/" + parts.slice(0, -1).join("/");
        const parentUrl = u.origin + (parentPath === "/" ? "" : parentPath);
        if (urls.has(parentUrl) && parentUrl !== page.url) {
          edges.push({ source: parentUrl, target: page.url });
        } else if (parts.length === 0 || parentPath === "/") {
          // Root or direct child of root — link to origin
          const rootUrl = u.origin + "/";
          if (urls.has(rootUrl) && rootUrl !== page.url) {
            edges.push({ source: rootUrl, target: page.url });
          }
        }
      }
    } catch { /* ignore malformed URLs */ }
  }
  return edges;
}

// ── Static SVG fallback (no D3) ───────────────────────────────────────────────

function StaticGraph({ pages, activePage, onNodeClick, testsByUrl }) {
  const W = 560, H = 360, R = 10;
  const count = pages.length;
  if (count === 0) return (
    <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text3)", fontSize: "0.8rem" }}>
      Waiting for pages…
    </div>
  );

  // Simple circular layout
  const nodes = pages.map((p, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    const rad   = Math.min(W, H) / 2 - 40;
    return { ...p, x: W / 2 + rad * Math.cos(angle), y: H / 2 + rad * Math.sin(angle) };
  });

  const edges = inferEdges(pages);
  const posMap = Object.fromEntries(nodes.map(n => [n.url, n]));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {/* Edges */}
      {edges.map((e, i) => {
        const s = posMap[e.source], t = posMap[e.target];
        if (!s || !t) return null;
        return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="#e2e8f0" strokeWidth={1} />;
      })}
      {/* Nodes */}
      {nodes.map((n, i) => {
        const { fill, stroke, strokeW } = nodeColor(n, testsByUrl);
        const isActive = n.url === activePage;
        return (
          <g key={i} style={{ cursor: "pointer" }} onClick={() => onNodeClick?.(n)}>
            {isActive && <circle cx={n.x} cy={n.y} r={R + 5} fill="#bfdbfe" opacity={0.6} style={{ animation: "pulse 1.4s ease-in-out infinite" }} />}
            <circle cx={n.x} cy={n.y} r={R} fill={fill} stroke={stroke} strokeWidth={strokeW} />
            <text x={n.x} y={n.y + R + 12} textAnchor="middle" fontSize={9} fill="#64748b" fontFamily="system-ui">
              {shortLabel(n.url)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── D3 force graph ────────────────────────────────────────────────────────────

function D3Graph({ pages, activePage, onNodeClick, d3, testsByUrl }) {
  const svgRef = useRef(null);
  const simRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current || !d3 || pages.length === 0) return;

    const W = svgRef.current.clientWidth || 560;
    const H = 360;
    const R = 10;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();
    svg.attr("viewBox", `0 0 ${W} ${H}`);

    const g = svg.append("g");

    // Zoom + pan
    svg.call(d3.zoom().scaleExtent([0.4, 3]).on("zoom", (event) => {
      g.attr("transform", event.transform);
    }));

    const edges  = inferEdges(pages);
    const nodeMap = Object.fromEntries(pages.map(p => [p.url, { ...p, id: p.url }]));
    const nodes  = Object.values(nodeMap);
    const links  = edges
      .filter(e => nodeMap[e.source] && nodeMap[e.target])
      .map(e => ({ source: e.source, target: e.target }));

    // Simulation
    const sim = d3.forceSimulation(nodes)
      .force("link",   d3.forceLink(links).id(d => d.id).distance(80))
      .force("charge", d3.forceManyBody().strength(-120))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collide", d3.forceCollide(R + 8));
    simRef.current = sim;

    // Edges
    const link = g.append("g").selectAll("line").data(links).join("line")
      .attr("stroke", "#e2e8f0").attr("stroke-width", 1.5);

    // Nodes
    const node = g.append("g").selectAll("g").data(nodes).join("g")
      .attr("cursor", "pointer")
      .on("click", (_, d) => onNodeClick?.(d))
      .call(d3.drag()
        .on("start", (event, d) => { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag",  (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on("end",   (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

    // Pulse ring for active node
    node.each(function(d) {
      if (d.url === activePage) {
        d3.select(this).append("circle")
          .attr("r", R + 5).attr("fill", "#bfdbfe").attr("opacity", 0.55)
          .style("animation", "pulse 1.4s ease-in-out infinite");
      }
    });

    node.append("circle")
      .attr("r", R)
      .attr("fill",         d => nodeColor(d, testsByUrl).fill)
      .attr("stroke",       d => nodeColor(d, testsByUrl).stroke)
      .attr("stroke-width", d => nodeColor(d, testsByUrl).strokeW);

    node.append("text")
      .attr("dy", R + 12).attr("text-anchor", "middle")
      .attr("font-size", 9).attr("fill", "#64748b").attr("font-family", "system-ui")
      .text(d => shortLabel(d.url));

    // Tooltip title
    node.append("title").text(d => d.url);

    sim.on("tick", () => {
      link.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
          .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      node.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    return () => { sim.stop(); };
  }, [pages, activePage, d3, onNodeClick, testsByUrl]);

  return <svg ref={svgRef} style={{ width: "100%", height: 360, display: "block" }} />;
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function SiteGraph({ pages = [], activePage, onNodeClick, isRunning, testsByUrl }) {
  const [d3, setD3]         = useState(null);
  const [d3Failed, setD3Failed] = useState(false);

  // Lazily load D3 from CDN
  useEffect(() => {
    if (window.d3) { setD3(window.d3); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js";
    s.onload  = () => setD3(window.d3);
    s.onerror = () => setD3Failed(true);
    document.head.appendChild(s);
    return () => { /* leave script in head for reuse */ };
  }, []);

  // DIF-011: Show heatmap legend when testsByUrl is available, legacy otherwise
  const legend = testsByUrl ? [
    { color: "#22c55e", bg: "#dcfce7", label: "3+ tests" },
    { color: "#f59e0b", bg: "#fef3c7", label: "1–2 tests" },
    { color: "#ef4444", bg: "#fee2e2", label: "No tests" },
    { color: "#3b82f6", bg: "#bfdbfe", label: "Active" },
  ] : [
    { color: "#22c55e", bg: "#dcfce7", label: "Has tests" },
    { color: "#94a3b8", bg: "#f1f5f9", label: "Crawled" },
    { color: "#ef4444", bg: "#fee2e2", label: "Error" },
    { color: "#3b82f6", bg: "#bfdbfe", label: "Active" },
  ];

  return (
    <div>
      {/* Legend */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        {legend.map(l => (
          <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: l.bg, border: `2px solid ${l.color}` }} />
            <span style={{ fontSize: "0.68rem", color: "var(--text3)" }}>{l.label}</span>
          </div>
        ))}
        {isRunning && (
          <span style={{ marginLeft: "auto", fontSize: "0.68rem", color: "var(--blue)", display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--blue)", display: "inline-block", animation: "pulse 1.4s ease-in-out infinite" }} />
            Live
          </span>
        )}
        <span style={{ fontSize: "0.68rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
          {pages.length} page{pages.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Graph area */}
      <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", minHeight: 200 }}>
        {pages.length === 0 ? (
          <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 10, color: "var(--text3)" }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", border: "3px solid var(--border)", borderTopColor: "var(--blue)", animation: isRunning ? "spin 0.9s linear infinite" : "none" }} />
            <span style={{ fontSize: "0.78rem" }}>
              {isRunning ? "Crawling pages…" : "No pages found"}
            </span>
          </div>
        ) : d3 ? (
          <D3Graph pages={pages} activePage={activePage} onNodeClick={onNodeClick} d3={d3} testsByUrl={testsByUrl} />
        ) : (
          <StaticGraph pages={pages} activePage={activePage} onNodeClick={onNodeClick} testsByUrl={testsByUrl} />
        )}
      </div>
    </div>
  );
}
