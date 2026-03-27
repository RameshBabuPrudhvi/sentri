import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Globe, ArrowRight, Clock } from "lucide-react";
import { api } from "../api.js";

export default function Projects() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    api.getProjects().then(setProjects).finally(() => setLoading(false));
  }, []);

  return (
    <div className="fade-in">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32 }}>
        <div>
          <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.9rem" }}>Projects</h1>
          <p style={{ color: "var(--text2)", marginTop: 6 }}>{projects.length} project{projects.length !== 1 ? "s" : ""} configured</p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate("/projects/new")}>
          <Plus size={16} /> New Project
        </button>
      </div>

      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton" style={{ height: 140, borderRadius: 16 }} />)}
        </div>
      ) : projects.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "80px 40px" }}>
          <div style={{ fontSize: "3rem", marginBottom: 16 }}>🌐</div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1.2rem", marginBottom: 8 }}>No projects yet</div>
          <div style={{ color: "var(--text2)", marginBottom: 24 }}>Add your first web application to start autonomous QA testing</div>
          <button className="btn btn-primary" onClick={() => navigate("/projects/new")}>
            <Plus size={16} /> Create First Project
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
          {projects.map((p) => (
            <div
              key={p.id}
              className="card card-hover"
              style={{ cursor: "pointer" }}
              onClick={() => navigate(`/projects/${p.id}`)}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ width: 36, height: 36, background: "rgba(0,229,255,0.1)", borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(0,229,255,0.15)" }}>
                  <Globe size={18} color="var(--accent)" />
                </div>
                <ArrowRight size={16} color="var(--text3)" />
              </div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1.05rem", marginBottom: 6 }}>{p.name}</div>
              <div className="mono truncate" style={{ color: "var(--text3)", fontSize: "0.78rem", marginBottom: 14 }}>{p.url}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text3)", fontSize: "0.76rem" }}>
                <Clock size={11} />
                {new Date(p.createdAt).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
