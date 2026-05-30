/**
 * @module tests/db-write-queue
 * @description B1.2 (AUDIT-ROADMAP Bundle 1) — write-batching queue contract.
 *
 * Locks in the documented behaviour of `utils/dbWriteQueue.js`:
 *
 *   - `enqueue(fn)`               → batched (default); flushed on size or time trigger.
 *   - `enqueue(fn, "durable")`    → synchronous transaction; lose-nothing.
 *   - `enqueue(fn, "high")`       → back-compat alias for `"durable"`.
 *   - `drain()`                   → synchronous flush of all pending writes.
 *   - Poison-pill replay          → one throwing closure rolls back the batch;
 *                                   survivors are re-attempted individually so
 *                                   one bad write never silently drops 49 others.
 *   - Postgres dialect passthrough is verified via `getDatabaseDialect()` —
 *     the test skips the batched-behaviour assertions when running against
 *     Postgres (the queue is documented as a passthrough there).
 */

import assert from "node:assert/strict";
import { getDatabase, getDatabaseDialect } from "../src/database/sqlite.js";
import { enqueue, drain, depth } from "../src/utils/dbWriteQueue.js";

const TABLE = "dbwq_test_rows";

function resetTable() {
  const db = getDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )`);
  db.exec(`DELETE FROM ${TABLE}`);
}

function rowCount() {
  return getDatabase().prepare(`SELECT COUNT(*) AS cnt FROM ${TABLE}`).get().cnt;
}

function insertOne(id, label) {
  return () => {
    const db = getDatabase();
    db.prepare(`INSERT INTO ${TABLE} (id, label, createdAt) VALUES (?, ?, ?)`)
      .run(id, label, new Date().toISOString());
  };
}

import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const runner = t.createTestRunner();

async function main() {
  const isPostgres = getDatabaseDialect() === "postgres";

  // Each test gets a fresh table + drained queue so prior state can't bleed.
  function setup() { resetTable(); drain(); }

  // ── durable mode is always synchronous ─────────────────────────────────
  // The durable contract is dialect-independent: callers passing
  // `priority: "durable"` (or the legacy `"high"` alias) must observe the
  // row before the call returns, on both SQLite and Postgres.
  await runner.test("durable: write is visible synchronously before the next statement", () => {
    setup();
    enqueue(insertOne("dbwq-1", "durable-row"), { priority: "durable" });
    assert.equal(rowCount(), 1, "durable enqueue did not commit synchronously");
  });

  await runner.test("priority='high' is a back-compat alias for 'durable'", () => {
    setup();
    enqueue(insertOne("dbwq-2", "high-row"), { priority: "high" });
    assert.equal(rowCount(), 1, "'high' priority did not commit synchronously");
  });

  // ── batched mode (SQLite only) ─────────────────────────────────────────
  // On Postgres the queue is a passthrough, so the row appears immediately
  // even without `priority: "durable"`. Skip the staging-then-drain assertion
  // there — the test would assert "row not yet visible" against a backend
  // that is documented to short-circuit batching.
  if (!isPostgres) {
    await runner.test("batched: writes accumulate in the queue until drain() (SQLite)", () => {
      setup();
      enqueue(insertOne("dbwq-3", "batched-row"));
      // The row is in the queue but not yet committed — depth() reflects this.
      assert.ok(depth() >= 1, `expected queue depth >= 1, got ${depth()}`);
      // No flush has fired yet (batch size = 50 default, flush ms = 100); the
      // synchronous drain() should commit it before returning.
      const flushed = drain();
      assert.equal(flushed, 1, `expected 1 op flushed, got ${flushed}`);
      assert.equal(rowCount(), 1, "batched row missing after drain");
      assert.equal(depth(), 0, "queue depth not zeroed after drain");
    });

    await runner.test("batched: drain() handles an empty queue cleanly (no-op)", () => {
      setup();
      assert.equal(drain(), 0, "empty drain should report 0 ops");
      assert.equal(rowCount(), 0);
    });

    await runner.test("batched: 25 enqueues + drain() commits all 25 rows", () => {
      setup();
      for (let i = 0; i < 25; i++) {
        enqueue(insertOne(`dbwq-bulk-${i}`, `bulk-${i}`));
      }
      assert.equal(depth(), 25, "queue should have 25 pending");
      drain();
      assert.equal(rowCount(), 25, "drain did not commit all 25 rows");
      assert.equal(depth(), 0);
    });
  }

  // ── poison-pill replay ─────────────────────────────────────────────────
  // One bad write rolls back the batch, then survivors are re-attempted
  // individually so they still land. Industry-standard "one bad row never
  // silently drops 49 others" semantics — same shape as PgBouncer's
  // `server_reset_query` flow and Sidekiq's `Sidekiq::Limiter` retry.
  await runner.test("poison pill: a throwing closure does not drop sibling survivors", () => {
    setup();
    enqueue(insertOne("dbwq-survivor-1", "ok"));
    // Closure that throws — the inner exception will roll back the batch
    // transaction; the queue's `flushNow` should then replay the survivors
    // one-by-one so the two `ok` rows still commit.
    enqueue(() => { throw new Error("intentional poison-pill in test"); });
    enqueue(insertOne("dbwq-survivor-2", "ok"));
    drain();
    const count = rowCount();
    assert.equal(count, 2,
      `expected 2 survivor rows after poison-pill replay, got ${count}`);
  });

  // ── enqueue() ignores non-function input ───────────────────────────────
  await runner.test("enqueue: non-function input is silently ignored (no throw)", () => {
    setup();
    enqueue(null);
    enqueue(undefined);
    enqueue(42);
    enqueue("not a function");
    assert.equal(depth(), 0, "non-function inputs leaked into the queue");
    drain();
    assert.equal(rowCount(), 0);
  });

  // ── drain idempotency ──────────────────────────────────────────────────
  await runner.test("drain: idempotent — second call is a no-op", () => {
    setup();
    enqueue(insertOne("dbwq-idem", "idempotent"), { priority: "durable" });
    assert.equal(drain(), 0, "first drain after durable write should be a no-op");
    assert.equal(drain(), 0, "second drain should also be a no-op");
    assert.equal(rowCount(), 1);
  });

  // ── cleanup ────────────────────────────────────────────────────────────
  getDatabase().exec(`DROP TABLE IF EXISTS ${TABLE}`);

  runner.summary("db-write-queue");
}

main().catch((err) => {
  console.error("❌ db-write-queue failed:", err);
  process.exit(1);
});
