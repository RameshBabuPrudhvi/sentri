/**
 * @module components/project/TraceabilityTab
 * @description Traceability matrix tab for ProjectDetail — shows requirement → test coverage.
 */

import React from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw, Info, Link2 } from "lucide-react";
import { testTypeBadgeClass, testTypeLabel } from "../../utils/testTypeLabels.js";
import { StatusBadge, ReviewBadge } from "../shared/TestBadges.jsx";

export default function TraceabilityTab({ traceability, traceLoading }) {
  const navigate = useNavigate();

  if (traceLoading) {
    return (
      <div className="card" style={{ padding: "60px 24px", textAlign: "center", color: "var(--text2)" }}>
        <RefreshCw size={20} className="spin" style={{ opacity: 0.3, marginBottom: 12 }} />
        <div>Loading traceability matrix…</div>
      </div>
    );
  }

  if (!traceability) return null;

  const hasMatrix = Object.keys(traceability.matrix || {}).length > 0;
  const hasUnlinked = traceability.unlinked?.length > 0;

  return (
    <div>
      {/* Summary stats */}
      <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          { label: "Total tests",    val: traceability.totalTests,   color: "var(--text)" },
          { label: "Linked issues",   val: traceability.linkedIssues, color: "var(--accent)" },
          { label: "Unlinked tests",  val: traceability.unlinkedTests, color: traceability.unlinkedTests > 0 ? "var(--amber)" : "var(--green)" },
        ].map((s, i) => (
          <div key={i} className="card" style={{ padding: "16px 20px", flex: 1, minWidth: 140 }}>
            <div style={{ fontSize: "1.4rem", fontWeight: 700, color: s.color }}>{s.val}</div>
            <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Linked issues matrix */}
      {hasMatrix && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ padding: "16px 20px 0", display: "flex", alignItems: "center", gap: 8 }}>
            <Link2 size={15} color="var(--accent)" />
            <h3 style={{ fontWeight: 700, fontSize: "0.95rem", margin: 0 }}>Requirement → Test Coverage</h3>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Issue Key</th>
                <th>Tests</th>
                <th>Types</th>
                <th>Status</th>
                <th>Last Result</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(traceability.matrix).map(([issueKey, issueTests]) => (
                <tr key={issueKey}>
                  <td>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.82rem", color: "var(--accent)", fontWeight: 600 }}>
                      {issueKey}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      {issueTests.map(t => (
                        <span
                          key={t.testId}
                          style={{ fontSize: "0.78rem", color: "var(--text)", cursor: "pointer" }}
                          onClick={() => navigate(`/tests/${t.testId}`)}
                        >
                          {t.name}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {[...new Set(issueTests.map(t => t.type).filter(Boolean))].map(type => (
                        <span key={type} className={`badge ${testTypeBadgeClass(type)}`} style={{ fontSize: "0.65rem" }}>
                          {testTypeLabel(type, true)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {[...new Set(issueTests.map(t => t.reviewStatus))].map(rs => (
                        <ReviewBadge key={rs} status={rs} />
                      ))}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {[...new Set(issueTests.map(t => t.lastResult).filter(Boolean))].map(r => (
                        <StatusBadge key={r} s={r} />
                      ))}
                      {issueTests.every(t => !t.lastResult) && <span style={{ fontSize: "0.78rem", color: "var(--text3)" }}>Not run</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Unlinked tests */}
      {hasUnlinked && (
        <div className="card">
          <div style={{ padding: "16px 20px 0", display: "flex", alignItems: "center", gap: 8 }}>
            <Info size={15} color="var(--amber)" />
            <h3 style={{ fontWeight: 700, fontSize: "0.95rem", margin: 0 }}>
              Unlinked Tests ({traceability.unlinked.length})
            </h3>
            <span style={{ fontSize: "0.75rem", color: "var(--text3)", marginLeft: 8 }}>
              These tests aren't linked to any requirement — link them via Test Detail to improve coverage visibility.
            </span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Test Name</th>
                <th>Type</th>
                <th>Priority</th>
                <th>Review</th>
                <th>Last Result</th>
              </tr>
            </thead>
            <tbody>
              {traceability.unlinked.slice(0, 20).map(t => (
                <tr key={t.testId} style={{ cursor: "pointer" }} onClick={() => navigate(`/tests/${t.testId}`)}>
                  <td style={{ fontSize: "0.82rem" }}>{t.name}</td>
                  <td>
                    {t.type && <span className={`badge ${testTypeBadgeClass(t.type)}`} style={{ fontSize: "0.65rem" }}>{testTypeLabel(t.type, true)}</span>}
                  </td>
                  <td>
                    <span className={`badge ${t.priority === "high" ? "badge-red" : "badge-gray"}`} style={{ fontSize: "0.65rem" }}>
                      {t.priority || "medium"}
                    </span>
                  </td>
                  <td><ReviewBadge status={t.reviewStatus} /></td>
                  <td><StatusBadge s={t.lastResult} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {traceability.unlinked.length > 20 && (
            <div style={{ padding: "10px 20px", fontSize: "0.78rem", color: "var(--text3)", textAlign: "center" }}>
              Showing 20 of {traceability.unlinked.length} unlinked tests
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {!hasMatrix && !hasUnlinked && (
        <div className="card" style={{ padding: "60px 24px", textAlign: "center", color: "var(--text2)" }}>
          <Link2 size={32} style={{ opacity: 0.2, marginBottom: 12 }} />
          <div style={{ fontWeight: 600, marginBottom: 6 }}>No traceability data yet</div>
          <div style={{ fontSize: "0.875rem" }}>Link tests to Jira issues in the Test Detail page to build your requirement → test → result matrix.</div>
        </div>
      )}
    </div>
  );
}
