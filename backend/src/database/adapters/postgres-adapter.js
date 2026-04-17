/**
 * @module database/adapters/postgres-adapter
 * @description PostgreSQL adapter implementing the db-adapter interface.
 *
 * Uses the `pg` package with `pg-native` for synchronous query execution.
 * The existing repository layer calls `db.prepare().run()` synchronously
 * (better-sqlite3 API), so this adapter provides the same blocking semantics.
 *
 * ### Prerequisites
 * ```bash
 * npm install pg pg-native
 * ```
 * `pg-native` provides libpq C bindings with a `querySync` method.
 * If `pg-native` is not installed, the adapter falls back to `deasync`
 * (`npm install deasync`) to block the event loop on async pool queries.
 *
 * ### SQL compatibility
 * Automatically translates common SQLite-isms to PostgreSQL:
 * - `@param` named bindings → `$N` positional parameters
 * - `INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY`
 * - `datetime('now')` → `NOW()`
 * - `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`
 * - `INSERT OR REPLACE` → upsert via `ON CONFLICT DO UPDATE SET`
 * - `LIKE` → `ILIKE` (case-insensitive matching)
 * - `PRAGMA table_info(t)` → `information_schema.columns` query
 *
 * ### Column name case mapping
 * PostgreSQL folds unquoted identifiers to lowercase (`passwordHash` → `passwordhash`).
 * The adapter automatically remaps lowercase column names back to camelCase on
 * every returned row so the application code works identically on both backends.
 *
 * @exports createPostgresAdapter
 */

import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "module";
import { formatLogLine } from "../../utils/logFormatter.js";

const { Pool } = pg;
const _require = createRequire(import.meta.url);

// Try to load pg-native for synchronous query support
let PgNative = null;
try {
  PgNative = _require("pg-native");
} catch {
  // pg-native not installed — will try deasync fallback
}

// Try to load deasync for async→sync bridge
let deasyncLib = null;
if (!PgNative) {
  try {
    deasyncLib = _require("deasync");
  } catch {
    // Neither available — will throw on createPostgresAdapter()
  }
}

// ─── SQL dialect translation ──────────────────────────────────────────────────

/**
 * Mask single-quoted string literals in SQL so regex replacements don't
 * corrupt values inside strings.  Returns the masked SQL and a restore
 * function that puts the original literals back.
 *
 * @param {string} sql
 * @returns {{ masked: string, restore: Function }}
 */
function maskStringLiterals(sql) {
  const literals = [];
  const masked = sql.replace(/'(?:[^']|'')*'/g, (match) => {
    const idx = literals.length;
    literals.push(match);
    return `__STRLIT_${idx}__`;
  });
  return {
    masked,
    restore(s) {
      return s.replace(/__STRLIT_(\d+)__/g, (_m, i) => literals[Number(i)]);
    },
  };
}

/**
 * Translate a single SQL statement from SQLite dialect to PostgreSQL.
 *
 * String literals are masked before replacements and restored afterward
 * so that values like `'I LIKE cats'` are never corrupted to `'I ILIKE cats'`.
 *
 * @param {string} stmt — a single SQL statement (no trailing semicolons expected)
 * @returns {string} PostgreSQL-compatible SQL statement
 */
function translateSingleStatement(stmt) {
  // datetime('now') → NOW()  — must run BEFORE maskStringLiterals because
  // the masker treats 'now' as a string literal and replaces it with a
  // placeholder, preventing the regex from matching.
  let pre = stmt.replace(/datetime\('now'\)/gi, "NOW()");

  const { masked, restore } = maskStringLiterals(pre);
  let out = masked;

  // INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY
  out = out.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, "SERIAL PRIMARY KEY");

  // INSERT OR IGNORE INTO → INSERT INTO ... ON CONFLICT DO NOTHING
  if (/INSERT\s+OR\s+IGNORE/i.test(out)) {
    out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO");
    if (!/ON\s+CONFLICT/i.test(out)) {
      out = out.trimEnd() + " ON CONFLICT DO NOTHING";
    }
  }

  // INSERT OR REPLACE INTO → INSERT INTO ... ON CONFLICT DO UPDATE SET
  if (/INSERT\s+OR\s+REPLACE\s+INTO/i.test(out)) {
    out = out.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, "INSERT INTO");
    if (!/ON\s+CONFLICT/i.test(out)) {
      const match = out.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/i);
      if (match) {
        const cols = match[2].split(",").map(c => c.trim());
        const pk = cols[0];
        const updateCols = cols.slice(1);
        if (updateCols.length > 0) {
          const setClauses = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(", ");
          out = out.trimEnd() + ` ON CONFLICT(${pk}) DO UPDATE SET ${setClauses}`;
        } else {
          out = out.trimEnd() + ` ON CONFLICT(${pk}) DO NOTHING`;
        }
      }
    }
  }

  // SQLite LIKE is case-insensitive by default; PostgreSQL LIKE is case-sensitive.
  // Case-insensitive flag so both `LIKE` and `like` are translated.
  out = out.replace(/\bLIKE\b/gi, "ILIKE");

  return restore(out);
}

/**
 * Convert SQLite-flavoured SQL to PostgreSQL.
 *
 * Splits multi-statement SQL on semicolons (respecting string literals),
 * translates each statement individually, and rejoins. This ensures that
 * INSERT OR IGNORE / INSERT OR REPLACE clauses each receive their own
 * ON CONFLICT suffix rather than only the last statement.
 *
 * @param {string} sql
 * @returns {string} PostgreSQL-compatible SQL
 */
export function translateSql(sql) {
  // Split on semicolons that are NOT inside single-quoted string literals
  // and NOT inside -- line comments.
  // This handles migration files with multiple statements and SQL comments
  // that may contain semicolons (e.g. `-- ISO 8601; checked on every ...`).
  const statements = [];
  let current = "";
  let inString = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    // End of line comment on newline
    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }

    // Detect start of -- line comment (only outside strings)
    if (!inString && ch === "-" && i + 1 < sql.length && sql[i + 1] === "-") {
      inLineComment = true;
      current += ch;
      continue;
    }

    if (ch === "'" && !inString) {
      inString = true;
      current += ch;
    } else if (ch === "'" && inString) {
      // Handle escaped single quotes ('')
      if (i + 1 < sql.length && sql[i + 1] === "'") {
        current += "''";
        i++;
      } else {
        inString = false;
        current += ch;
      }
    } else if (ch === ";" && !inString) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }
  const lastTrimmed = current.trim();
  if (lastTrimmed) statements.push(lastTrimmed);

  if (statements.length === 0) return sql;

  // Translate each statement individually and rejoin with semicolons.
  return statements.map(s => translateSingleStatement(s)).join(";\n") + ";";
}

/**
 * Convert `@name` named parameters to `$N` positional parameters.
 *
 * String literals are masked before replacement so that email addresses
 * or other values containing `@` inside quoted strings are not treated
 * as parameter placeholders (e.g. `'user@example.com'` stays intact).
 *
 * @param {string} sql — SQL with `@name` placeholders
 * @param {Object} namedParams — `{ name: value, ... }`
 * @returns {{ sql: string, values: any[] }}
 */
function namedToPositional(sql, namedParams) {
  const { masked, restore } = maskStringLiterals(sql);
  const paramIndex = {};
  const values = [];
  let idx = 0;
  const translated = masked.replace(/@(\w+)/g, (_match, name) => {
    if (!(name in paramIndex)) {
      idx++;
      paramIndex[name] = idx;
      values.push(namedParams[name] !== undefined ? namedParams[name] : null);
    }
    return `$${paramIndex[name]}`;
  });
  return { sql: restore(translated), values };
}

/**
 * Convert `?` positional placeholders to `$N` numbered placeholders.
 *
 * String literals are masked before replacement so that `?` inside
 * quoted strings (e.g. `'What?'`) is not treated as a placeholder.
 *
 * @param {string} sql
 * @returns {string}
 */
function questionToNumbered(sql) {
  const { masked, restore } = maskStringLiterals(sql);
  let idx = 0;
  return restore(masked.replace(/\?/g, () => `$${++idx}`));
}

/**
 * Determine if args represent a named-params object (vs positional args).
 *
 * @param {any[]} args
 * @returns {boolean}
 */
function isNamedParams(args) {
  return args.length === 1
    && typeof args[0] === "object"
    && args[0] !== null
    && !Array.isArray(args[0]);
}

// ─── Column name case mapping ─────────────────────────────────────────────────
// PostgreSQL folds unquoted identifiers to lowercase. The migration SQL uses
// camelCase column names (e.g. `passwordHash`) which PostgreSQL stores as
// `passwordhash`. When rows are returned, the keys are all lowercase.
// The application code expects camelCase, so we remap on every row returned.
// This is cheaper than quoting every identifier in every SQL statement.

/**
 * Build a lowercase → camelCase lookup from a list of camelCase names.
 * Only entries where lowercase differs from the original are included.
 * @param {string[]} names
 * @returns {Object<string, string>}
 */
function buildColumnMap(names) {
  const map = {};
  for (const n of names) {
    const lower = n.toLowerCase();
    if (lower !== n) map[lower] = n;
  }
  return map;
}

/** All camelCase column names used across the schema. */
const _COL_MAP = buildColumnMap([
  // users
  "passwordHash", "createdAt", "updatedAt", "emailVerified",
  // oauth_ids
  "userId",
  // projects
  "deletedAt",
  // tests
  "projectId", "playwrightCode", "playwrightCodePrev", "sourceUrl", "pageTitle",
  "lastResult", "lastRunAt", "qualityScore", "isJourneyTest", "journeyType",
  "assertionEnhanced", "reviewStatus", "reviewedAt", "promptVersion", "modelUsed",
  "linkedIssueKey", "generatedFrom", "isApiTest", "codeRegeneratedAt",
  "aiFixAppliedAt", "codeVersion",
  // runs
  "startedAt", "finishedAt", "errorCategory", "pagesFound", "parallelWorkers",
  "tracePath", "videoPath", "videoSegments", "testQueue", "generateInput",
  "promptAudit", "pipelineStats", "feedbackLoop", "currentStep", "rateLimitError",
  "qualityAnalytics",
  // activities
  "projectName", "testId", "testName", "userName",
  // healing_history
  "strategyIndex", "succeededAt", "failCount", "strategyVersion",
  // password_reset_tokens & verification_tokens
  "expiresAt", "usedAt",
  // webhook_tokens (migration 002)
  "tokenHash", "lastUsedAt",
  // schedules (migration 002)
  "cronExpr", "nextRunAt",
  // run_logs (migration 002)
  "runId",
  // schema_migrations
  "appliedAt", "durationMs",
  // information_schema queries
  "column_name", "data_type",
]);

/**
 * Remap lowercase PostgreSQL column names to camelCase on a single row object.
 * Keys that are already camelCase or not in the map are left unchanged.
 * @param {Object} row
 * @returns {Object}
 */
function remapRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const key of Object.keys(row)) {
    out[_COL_MAP[key] || key] = row[key];
  }
  return out;
}

/**
 * Remap all rows in an array.
 * @param {Object[]} rows
 * @returns {Object[]}
 */
function remapRows(rows) {
  if (!rows || rows.length === 0) return rows;
  // Fast path: check if the first row has any lowercase keys that need mapping
  const firstKeys = Object.keys(rows[0]);
  const needsRemap = firstKeys.some(k => k in _COL_MAP);
  if (!needsRemap) return rows;
  return rows.map(remapRow);
}

// ─── Adapter factory ──────────────────────────────────────────────────────────

/**
 * Create a PostgreSQL adapter instance.
 *
 * @param {Object}  [opts]
 * @param {string}  [opts.connectionString] — PostgreSQL connection URL.
 *   Defaults to `process.env.DATABASE_URL`.
 * @param {number}  [opts.poolSize] — Max pool connections (default 10).
 * @returns {Object} Adapter conforming to the db-adapter interface.
 * @throws {Error} If `DATABASE_URL` is not set.
 * @throws {Error} If neither `pg-native` nor `deasync` is installed.
 */
export function createPostgresAdapter(opts = {}) {
  const connectionString = opts.connectionString || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("[postgres-adapter] DATABASE_URL is required");
  }

  if (!PgNative && !deasyncLib) {
    throw new Error(
      "[postgres-adapter] PostgreSQL requires either `pg-native` (recommended) " +
      "or `deasync` for synchronous query execution. Install one:\n" +
      "  npm install pg-native    # recommended — uses libpq C bindings\n" +
      "  npm install deasync      # fallback — blocks event loop"
    );
  }

  // ── pg-native synchronous path ────────────────────────────────────────
  let nativeClient = null;
  if (PgNative) {
    nativeClient = new PgNative();
    nativeClient.connectSync(connectionString);
    console.log(formatLogLine("info", null, "[postgres-adapter] Connected via pg-native (synchronous)"));
  }

  /**
   * Reconnect the pg-native client if the connection was lost.
   * Called from query() when querySync throws a connection error.
   * @returns {boolean} true if reconnection succeeded.
   */
  function reconnectNativeClient() {
    if (!nativeClient || !PgNative) return false;
    try {
      console.warn(formatLogLine("warn", null, "[postgres-adapter] Connection lost — attempting reconnect…"));
      // Create a fresh client — pg-native does not support reconnecting
      // an existing client after the underlying libpq connection is closed.
      nativeClient = new PgNative();
      nativeClient.connectSync(connectionString);
      console.log(formatLogLine("info", null, "[postgres-adapter] Reconnected via pg-native"));
      return true;
    } catch (err) {
      console.error(formatLogLine("error", null, `[postgres-adapter] Reconnect failed: ${err.message}`));
      return false;
    }
  }

  // ── deasync fallback path ─────────────────────────────────────────────
  const maxPool = opts.poolSize || parseInt(process.env.PG_POOL_SIZE, 10) || 10;
  const pool = !nativeClient ? new Pool({
    connectionString,
    max: maxPool,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  }) : null;

  if (pool) {
    console.log(formatLogLine("info", null, `[postgres-adapter] Connection pool created via deasync (max ${maxPool})`));
  }

  // When a deasync transaction is active, this Map holds the txQuery
  // function keyed by a unique transaction token.  Each call to
  // transaction() creates a fresh token and stores it in AsyncLocalStorage
  // so it is scoped to the current async execution context.  query()
  // reads the token from AsyncLocalStorage and looks up the corresponding
  // override.  This prevents concurrent requests (whose event-loop turns
  // are interleaved by deasyncLib.loopWhile) from accidentally routing
  // their queries through another transaction's dedicated client.
  const _txQueryOverrides = new Map();
  const _txStorage = new AsyncLocalStorage();

  /**
   * Detect whether a SQL statement is a DML command (INSERT/UPDATE/DELETE)
   * that does not already have a RETURNING clause. pg-native's querySync
   * only returns rows, so DML without RETURNING returns [] and we lose
   * the affected row count. Appending RETURNING * makes pg-native return
   * the affected rows so rows.length gives the correct count.
   *
   * @param {string} sql
   * @returns {string} SQL with RETURNING * appended if needed.
   */
  function ensureReturning(sql) {
    if (!nativeClient) return sql;
    const trimmed = sql.trimStart();
    const isDml = /^(INSERT|UPDATE|DELETE)\b/i.test(trimmed);
    if (!isDml) return sql;
    if (/\bRETURNING\b/i.test(sql)) return sql;
    return sql.trimEnd().replace(/;?\s*$/, "") + " RETURNING *";
  }

  /**
   * Execute a query synchronously.
   *
   * @param {string} sql
   * @param {any[]}  [values]
   * @returns {{ rows: Object[], rowCount: number }}
   */
  function query(sql, values = []) {
    if (nativeClient) {
      const execSql = ensureReturning(sql);
      try {
        const rows = nativeClient.querySync(execSql, values);
        return { rows: remapRows(rows), rowCount: rows.length };
      } catch (err) {
        // Attempt one reconnect on connection-level errors (e.g. PostgreSQL
        // restarted, TCP timeout). If the reconnect succeeds, retry the query.
        const isConnectionError = /connection|socket|EPIPE|ECONNRESET|terminating/i.test(err.message);
        if (isConnectionError && reconnectNativeClient()) {
          const rows = nativeClient.querySync(execSql, values);
          return { rows: remapRows(rows), rowCount: rows.length };
        }
        throw err;
      }
    }

    // If a deasync transaction is active on THIS async context, route the
    // query through the dedicated transaction client.  AsyncLocalStorage
    // ensures each request's transaction token is isolated even when
    // deasyncLib.loopWhile() interleaves event-loop turns from other requests.
    const txToken = _txStorage.getStore();
    if (txToken && _txQueryOverrides.has(txToken)) {
      return _txQueryOverrides.get(txToken)(sql, values);
    }

    // deasync fallback: run async query and block until it resolves
    let done = false;
    let result = null;
    let error = null;

    pool.query(sql, values)
      .then(r => { result = r; done = true; })
      .catch(e => { error = e; done = true; });

    deasyncLib.loopWhile(() => !done);

    if (error) throw error;
    return { rows: remapRows(result.rows), rowCount: result.rowCount || 0 };
  }

  /**
   * Handle PRAGMA table_info() calls by querying information_schema.
   *
   * @param {string} sql
   * @returns {Object} `{ isPragma: boolean, rows: Object[]|undefined }`
   */
  function handlePragmaTableInfo(sql) {
    const match = sql.match(/PRAGMA\s+table_info\((\w+)\)/i);
    if (!match) return { isPragma: false };
    const tableName = match[1];
    const pgSql = `SELECT column_name AS name, data_type AS type
      FROM information_schema.columns
      WHERE table_name = $1 ORDER BY ordinal_position`;
    const result = query(pgSql, [tableName]);
    return { isPragma: true, rows: result.rows };
  }

  return {
    /** @type {"postgres"} */
    dialect: "postgres",

    prepare(rawSql) {
      // Intercept PRAGMA table_info() calls
      const pragmaResult = handlePragmaTableInfo(rawSql);
      if (pragmaResult.isPragma) {
        return {
          run() { return { changes: 0 }; },
          get() { return pragmaResult.rows[0]; },
          all() { return pragmaResult.rows; },
        };
      }

      const pgSql = translateSql(rawSql);

      return {
        run(...args) {
          let sql, values;
          if (isNamedParams(args)) {
            ({ sql, values } = namedToPositional(pgSql, args[0]));
          } else {
            sql = questionToNumbered(pgSql);
            values = args;
          }
          const result = query(sql, values);
          if (result.rows && result.rows.length > 0) {
            return { changes: result.rowCount || 0, ...result.rows[0] };
          }
          return { changes: result.rowCount || 0 };
        },

        get(...args) {
          let sql, values;
          if (isNamedParams(args)) {
            ({ sql, values } = namedToPositional(pgSql, args[0]));
          } else {
            sql = questionToNumbered(pgSql);
            values = args;
          }
          const result = query(sql, values);
          return result.rows[0] || undefined;
        },

        all(...args) {
          let sql, values;
          if (isNamedParams(args)) {
            ({ sql, values } = namedToPositional(pgSql, args[0]));
          } else {
            sql = questionToNumbered(pgSql);
            values = args;
          }
          const result = query(sql, values);
          return result.rows;
        },
      };
    },

    exec(sql) {
      const pgSql = translateSql(sql);
      // Execute each statement individually — PostgreSQL's simple query
      // protocol handles multi-statement strings, but some DDL combinations
      // (e.g. CREATE TABLE + CREATE INDEX) can fail when sent as one query.
      // Split on the semicolons that translateSql() uses as delimiters.
      const stmts = pgSql.split(/;\s*\n/).map(s => s.replace(/;\s*$/, "").trim()).filter(Boolean);
      for (const stmt of stmts) {
        query(stmt);
      }
    },

    transaction(fn) {
      return function (...args) {
        if (nativeClient) {
          // pg-native uses a single connection — BEGIN/COMMIT are on the same client.
          query("BEGIN");
          try {
            const result = fn(...args);
            query("COMMIT");
            return result;
          } catch (err) {
            query("ROLLBACK");
            throw err;
          }
        }

        // Pool path: acquire a dedicated client so all statements within the
        // transaction run on the same connection. pool.query() checks out and
        // releases a connection per call, which would break transactional
        // semantics (BEGIN on conn A, body on conn B, COMMIT on conn C).
        let done = false;
        let client = null;
        let clientError = null;

        pool.connect()
          .then(c => { client = c; done = true; })
          .catch(e => { clientError = e; done = true; });
        deasyncLib.loopWhile(() => !done);
        if (clientError) throw clientError;

        /** Run a query on the dedicated transaction client. */
        function txQuery(sql, values = []) {
          let txDone = false;
          let txResult = null;
          let txError = null;
          client.query(sql, values)
            .then(r => { txResult = r; txDone = true; })
            .catch(e => { txError = e; txDone = true; });
          deasyncLib.loopWhile(() => !txDone);
          if (txError) throw txError;
          return { rows: remapRows(txResult.rows), rowCount: txResult.rowCount || 0 };
        }

        txQuery("BEGIN");
        // Redirect all query() calls inside fn() to the dedicated
        // transaction client so that db.prepare().run() etc. execute
        // within the same BEGIN/COMMIT block.
        // Use a unique Symbol token stored in AsyncLocalStorage so
        // concurrent transactions (interleaved by deasyncLib.loopWhile
        // pumping the event loop) each route to their own client.
        const txToken = Symbol("tx");
        _txQueryOverrides.set(txToken, txQuery);
        try {
          // _txStorage.run() scopes the token to this async context,
          // so query() in other request handlers won't see it.
          const result = _txStorage.run(txToken, () => fn(...args));
          txQuery("COMMIT");
          return result;
        } catch (err) {
          try { txQuery("ROLLBACK"); } catch { /* best-effort rollback */ }
          throw err;
        } finally {
          _txQueryOverrides.delete(txToken);
          client.release();
        }
      };
    },

    pragma(_str) {
      // No-op for PostgreSQL
    },

    async close() {
      if (nativeClient) {
        try {
          nativeClient.end();
          console.log(formatLogLine("info", null, "[postgres-adapter] Native client closed"));
        } catch (err) {
          console.warn(formatLogLine("warn", null, `[postgres-adapter] Close error: ${err.message}`));
        }
      }
      if (pool) {
        try {
          await pool.end();
          console.log(formatLogLine("info", null, "[postgres-adapter] Connection pool closed"));
        } catch (err) {
          console.warn(formatLogLine("warn", null, `[postgres-adapter] Pool close error: ${err.message}`));
        }
      }
    },
  };
}
