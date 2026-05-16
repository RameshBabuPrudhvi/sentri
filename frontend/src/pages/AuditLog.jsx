import { useEffect, useState } from "react";
import { api } from "../api.js";

export default function AuditLog() {
  const [rows, setRows] = useState([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const ws = await api.getWorkspace();
        setWorkspaceId(ws.id);
        const out = await api.getWorkspaceAuditLog(ws.id, {});
        setRows(out.rows || []);
      } catch (e) { setErr(e.message); }
    })();
  }, []);

  const exportFmt = async (format) => {
    const txt = await api.exportWorkspaceAuditLog(workspaceId, {}, format);
    alert(typeof txt === "string" ? `Exported ${format}` : `Export ready`);
  };

  return <div className="container">
    <h1>Compliance Audit Log</h1>
    {err && <p className="text-danger">{err}</p>}
    <div className="flex gap-2 mb-2">
      <button className="btn" onClick={() => exportFmt("csv")}>Export CSV</button>
      <button className="btn" onClick={() => exportFmt("ndjson")}>Export NDJSON</button>
    </div>
    <table className="table">
      <thead><tr><th>Time</th><th>User</th><th>Type</th><th>IP</th><th>UA</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id}><td>{r.createdAt}</td><td>{r.userName || r.userId}</td><td>{r.type}</td><td>{r.ipAddress || "-"}</td><td>{r.userAgent || "-"}</td></tr>)}</tbody>
    </table>
  </div>;
}
