import React from "react";
import { CheckCircle2, XCircle, Clock } from "lucide-react";

/**
 * Consistent status badge used in Work, Reports, and Dashboard.
 */
export default function StatusBadge({ status }) {
  if (status === "completed") return <span className="badge badge-green"><CheckCircle2 size={10} /> Completed</span>;
  if (status === "failed")    return <span className="badge badge-red"><XCircle size={10} /> Failed</span>;
  if (status === "running")   return <span className="badge badge-blue pulse">● Running</span>;
  if (status === "queued")    return <span className="badge badge-amber"><Clock size={10} /> Queued</span>;
  return <span className="badge badge-gray">{status || "Unknown"}</span>;
}
