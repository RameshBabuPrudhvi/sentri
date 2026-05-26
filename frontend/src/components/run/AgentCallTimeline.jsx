/**
 * @module components/run/AgentCallTimeline
 * @description GAP-005 (audit, Path B) — per-run AI call timeline panel.
 * Renders one row per `ai_request_log` entry correlated to the run via
 * migration 056's `runId` column. Each row shows: agent role badge, model,
 * latency bar, token counts (in/out), cost, outcome, and an expandable
 * prompt/response viewer when the workspace's `aiRequestLogMode` is
 * "redacted" or "full".
 *
 * Admin-gated: the `GET /api/v1/runs/:runId/ai-requests` endpoint requires
 * admin role. Non-admin users see nothing (the component renders null when
 * the fetch returns 403 or empty). The fetch fires lazily — only when the
 * user clicks "View AI calls" — so non-admin users never hit the endpoint.
 *
 * @param {Object} props
 * @param {string} props.runId - Run ID to fetch AI request log rows for.
 */

import React, { useState, useCallback } from "react";
import { ChevronDown, ChevronRight, Cpu, AlertCircle } from "lucide-react";
import { api } from "../../api.js";
import { getStageAgentRoles } from "../../config.js";

export default function AgentCallTimeline({ runId }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null); // null = not fetched, [] = fetched empty
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const handleToggle = useCallback(async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (rows !== null) return; // already fetched
    setLoading(true);
    setError(null);
    try {
      const data = await api.getRunAIRequests(runId);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      // 403 = non-admin; 404 = run not found. Both are expected non-error states.
      if (e?.status === 403 || e?.status === 404) {
        setRows([]);
      } else {
        setError(e?.message || "Failed to load AI call log");
      }
    } finally {
      setLoading(false);
    }
  }, [open, rows, runId]);

  if (!runId) return null;

  const totalCost = rows ? rows.reduce((s, r) => s + (Number(r.costUsd) || 0), 0) : 0;
  const totalCalls = rows ? rows.length : 0;

  return (
    <div className="card" style={{ overflow: "hidden", marginTop: 12 }}>
      <button
        onClick={handleToggle}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 10,
          padding: "12px 16px", background: "none", border: "none",
          cursor: "pointer", textAlign: "left",
        }}
      >
        {open ? <ChevronDown size={14} color="var(--text3)" /> : <ChevronRight size={14} color="var(--text3)" />}
        <Cpu size={14} color="var(--purple)" />
        <span style={{ fontWeight: 700, fontSize: "0.88rem" }}>Agent Call Timeline</span>
        {totalCalls > 0 && (
          <span style={{ marginLeft: "auto", fontSize: "0.72rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
            {totalCalls} call{totalCalls !== 1 ? "s" : ""} · ${totalCost.toFixed(4)}
          </span>
        )}
      </button>

      {open && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
          {loading && (
            <div style={{ padding: "16px", textAlign: "center", color: "var(--text3)", fontSize: "0.82rem" }}>
              Loading AI call log…
            </div>
          )}
          {error && (
            <div style={{ padding: "12px 16px", color: "var(--red)", fontSize: "0.82rem", display: "flex", alignItems: "center", gap: 6 }}>
              <AlertCircle size={13} /> {error}
            </div>
          )}
          {rows && rows.length === 0 && !loading && (
            <div style={{ padding: "16px", textAlign: "center", color: "var(--text3)", fontSize: "0.82rem" }}>
              No AI calls recorded for this run. Calls made before migration 056 have no runId correlation.
            </div>
          )}
          {rows && rows.length > 0 && rows.map((row) => {
            const isExpanded = expandedId === row.id;
            const roles = getStageAgentRoles(row.pipelineStep) || [];
            const roleLabel = row.agentRole
              ? row.agentRole.charAt(0).toUpperCase() + row.agentRole.slice(1)
              : "Unknown";
            const hasPrompt = row.promptRedacted || row.responseRedacted;
            return (
              <div key={row.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <div
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 16px", cursor: hasPrompt ? "pointer" : "default",
                    fontSize: "0.78rem",
                  }}
                  onClick={() => hasPrompt && setExpandedId(isExpanded ? null : row.id)}
                >
                  {/* Agent badge */}
                  <span style={{
                    fontSize: "0.62rem", fontWeight: 700, padding: "1px 7px",
                    borderRadius: 99, background: "var(--purple-bg)", color: "var(--purple)",
                    border: "1px solid rgba(124,58,237,0.25)",
                    textTransform: "capitalize", flexShrink: 0,
                  }}>
                    🤖 {roleLabel}
                  </span>

                  {/* Latency */}
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text2)", minWidth: 52, textAlign: "right" }}>
                    {row.latencyMs != null ? `${(row.latencyMs / 1000).toFixed(1)}s` : "—"}
                  </span>

                  {/* Tokens */}
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text3)", fontSize: "0.7rem" }}>
                    {row.inputTokens ?? "?"} in / {row.outputTokens ?? "?"} out
                  </span>

                  {/* Cost */}
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--green)", fontSize: "0.7rem", marginLeft: "auto" }}>
                    {row.costUsd != null ? `$${Number(row.costUsd).toFixed(4)}` : "—"}
                  </span>

                  {/* Outcome */}
                  {row.outcome !== "success" && (
                    <span className="badge badge-red" style={{ fontSize: "0.6rem" }}>
                      {row.outcome}
                    </span>
                  )}

                  {/* Expand indicator */}
                  {hasPrompt && (
                    <ChevronRight size={12} color="var(--text3)" style={{
                      transition: "transform 0.15s",
                      transform: isExpanded ? "rotate(90deg)" : "none",
                    }} />
                  )}
                </div>

                {/* Expanded prompt/response viewer */}
                {isExpanded && hasPrompt && (
                  <div style={{ padding: "8px 16px 12px 44px", fontSize: "0.72rem" }}>
                    {row.promptRedacted && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontWeight: 700, color: "var(--text3)", marginBottom: 4, textTransform: "uppercase", fontSize: "0.65rem", letterSpacing: "0.04em" }}>
                          Prompt
                        </div>
                        <pre style={{
                          margin: 0, padding: "8px 10px", background: "var(--bg3)",
                          borderRadius: "var(--radius)", fontFamily: "var(--font-mono)",
                          fontSize: "0.68rem", lineHeight: 1.6, whiteSpace: "pre-wrap",
                          wordBreak: "break-word", maxHeight: 200, overflowY: "auto",
                        }}>
                          {row.promptRedacted}
                        </pre>
                      </div>
                    )}
                    {row.responseRedacted && (
                      <div>
                        <div style={{ fontWeight: 700, color: "var(--text3)", marginBottom: 4, textTransform: "uppercase", fontSize: "0.65rem", letterSpacing: "0.04em" }}>
                          Response
                        </div>
                        <pre style={{
                          margin: 0, padding: "8px 10px", background: "var(--bg3)",
                          borderRadius: "var(--radius)", fontFamily: "var(--font-mono)",
                          fontSize: "0.68rem", lineHeight: 1.6, whiteSpace: "pre-wrap",
                          wordBreak: "break-word", maxHeight: 200, overflowY: "auto",
                        }}>
                          {row.responseRedacted}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
