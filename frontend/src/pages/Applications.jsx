import React, { useEffect, useState } from "react";
import { api } from "../api";
import { useNavigate } from "react-router-dom";

export default function Applications() {
  const [projects, setProjects] = useState([]);
  const navigate = useNavigate();

  useEffect(() => {
    api.getProjects().then(setProjects).catch(console.error);
  }, []);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 600, marginBottom: 20 }}>
        Applications
      </h1>

      {projects.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: "center" }}>
          <div style={{ marginBottom: 10 }}>No applications yet</div>
          <button className="btn btn-primary" onClick={() => navigate("/projects/new")}>
            Create Project
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {projects.map((p) => (
            <div
              key={p.id}
              className="card"
              style={{ padding: 16, cursor: "pointer" }}
              onClick={() => navigate(`/projects/${p.id}`)}
            >
              <div style={{ fontWeight: 600 }}>{p.name}</div>
              <div style={{ fontSize: "0.85rem", color: "gray" }}>{p.url}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}