import React from "react";

/**
 * Avatar chip for agent/run types.
 * type: "QA" | "TA" | "EX"
 * Used in Dashboard, ProjectDetail, Tests, Work, RunDetail.
 */
export default function AgentTag({ type = "TA" }) {
  const cls = { QA: "avatar-qa", TA: "avatar-ta", EX: "avatar-ex" };
  return <div className={`avatar ${cls[type] || "avatar-ta"}`}>{type}</div>;
}
