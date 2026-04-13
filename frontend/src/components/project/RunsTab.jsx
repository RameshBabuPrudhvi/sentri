/**
 * @module components/project/RunsTab
 * @description Runs table tab for ProjectDetail — lists all crawl/generate/test runs.
 */

import React, { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Ban } from "lucide-react";
import TablePagination, { PAGE_SIZE } from "../shared/TablePagination.jsx";

export default function RunsTab({ runs }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);

  const sorted = useMemo(() =>
    [...runs].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)),
  [runs]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paged = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  if (runs.length === 0) {
    return (
      <div className="card">
        <div style={{ padding: "60px 24px", textAlign: "center", color: "var(--text2)" }}>No runs yet</div>
      </div>
    );
  }

  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr><th>Run ID</th><th>Type</th><th>Status</th><th>Tests / Pages</th><th>Started</th><th></th></tr>
        </thead>
        <tbody>
          {paged.map(r => {
              const isCrawl    = r.type === "crawl";
              const isGenerate = r.type === "generate";
              const isRun      = r.type === "run" || r.type === "test_run";
              return (
                <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/runs/${r.id}`)}>
                  <td>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text3)" }}>
                      {r.id.length > 8 ? r.id.slice(0, 8) + "…" : r.id}
                    </span>
                  </td>
                  <td>
                    {isCrawl    && <span className="badge badge-accent">🔍 crawl</span>}
                    {isGenerate && <span className="badge badge-blue">⚡ generate</span>}
                    {isRun      && <span className="badge badge-green">▶ run</span>}
                    {!isCrawl && !isGenerate && !isRun && <span className="badge badge-gray">{r.type}</span>}
                  </td>
                  <td>
                    {r.status === "completed" && <span className="badge badge-green">✓ Completed</span>}
                    {r.status === "running"   && <span className="badge badge-blue" style={{ animation: "pulse 1.5s ease-in-out infinite" }}>● Running</span>}
                    {r.status === "failed"    && <span className="badge badge-red">✗ Failed</span>}
                    {r.status === "aborted"   && <span className="badge badge-gray"><Ban size={10} /> Aborted</span>}
                    {!["completed","running","failed","aborted"].includes(r.status) && <span className="badge badge-gray">{r.status}</span>}
                  </td>
                  <td>
                    {isCrawl && (
                      <span style={{ color: "var(--accent)", fontWeight: 600 }}>
                        {r.pagesFound ?? "—"} <span style={{ fontWeight: 400, color: "var(--text3)", fontSize: "0.73rem" }}>pages</span>
                      </span>
                    )}
                    {isGenerate && (
                      <span style={{ color: "var(--accent)", fontWeight: 600 }}>
                        {r.testsGenerated ?? r.pipelineStats?.rawTestsGenerated ?? "—"} <span style={{ fontWeight: 400, color: "var(--text3)", fontSize: "0.73rem" }}>tests</span>
                      </span>
                    )}
                    {isRun && (
                      <span>
                        <span style={{ color: "var(--green)", fontWeight: 600 }}>{r.passed ?? "—"}</span>
                        <span style={{ color: "var(--text3)", margin: "0 4px" }}>/</span>
                        <span style={{ color: "var(--red)", fontWeight: 600 }}>{r.failed ?? "—"}</span>
                        <span style={{ color: "var(--text3)", fontSize: "0.73rem", marginLeft: 4 }}>pass/fail</span>
                      </span>
                    )}
                  </td>
                  <td>
                    <span style={{ fontSize: "0.78rem", color: "var(--text2)" }}>
                      {new Date(r.startedAt).toLocaleString()}
                    </span>
                  </td>
                  <td><ArrowRight size={14} color="var(--text3)" /></td>
                </tr>
              );
            })}
        </tbody>
      </table>
      <TablePagination
        total={sorted.length}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        label="runs"
      />
    </div>
  );
}
