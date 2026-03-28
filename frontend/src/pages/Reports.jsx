export default function Reports() {
  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 600, marginBottom: 20 }}>
        Reports
      </h1>

      <div className="card" style={{ padding: 40, textAlign: "center" }}>
        <div style={{ fontWeight: 500, marginBottom: 10 }}>
          No reports yet
        </div>
        <div style={{ fontSize: "0.85rem", color: "gray" }}>
          Run tests to generate reports
        </div>
      </div>
    </div>
  );
}