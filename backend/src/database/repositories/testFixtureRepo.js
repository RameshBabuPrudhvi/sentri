import { getDatabase } from "../sqlite.js";

function rowToFixture(row){
  if(!row) return undefined;
  return { ...row, rows: row.rows ? JSON.parse(row.rows) : [] };
}

export function upsertFixture({ testId, version, format, rows }) {
  const db = getDatabase();
  const createdAt = new Date().toISOString();
  const payload = { testId, version, format, rows: JSON.stringify(rows || []), createdAt };
  db.prepare(`INSERT INTO test_fixtures (testId, version, format, rows, createdAt)
    VALUES (@testId, @version, @format, @rows, @createdAt)
    ON CONFLICT(testId, version) DO UPDATE SET
      format=excluded.format, rows=excluded.rows, createdAt=excluded.createdAt`).run(payload);
  return getFixture(testId, version);
}

export function getFixture(testId, version){
  const db=getDatabase();
  return rowToFixture(db.prepare('SELECT * FROM test_fixtures WHERE testId=? AND version=?').get(testId, version));
}

export function listFixtures(testId){
  const db=getDatabase();
  return db.prepare('SELECT * FROM test_fixtures WHERE testId=? ORDER BY version DESC').all(testId).map(rowToFixture);
}
