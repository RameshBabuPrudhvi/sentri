# Compliance Audit Log (SEC-007)

Sentri's `activities` table is the workspace's **compliance audit log**.
It is designed to meet SOC 2 (CC6.1, CC6.6, CC6.7, CC7.1, CC7.2),
ISO 27001 (A.8.12, A.8.15, A.8.16), and PCI-DSS 10.2.6 requirements
out of the box — every property is opt-in and **safe by default**.

This page documents the four operator-facing controls:

1. **Immutability** — admins cannot silently truncate the log
2. **Retention** — automatic purge of rows older than the configured window
3. **Tamper evidence** — optional cryptographic hash chain with verification
4. **SIEM integration** — forward every event to your security stack

---

## Quick reference

| Env var | Default | Purpose |
|---|---|---|
| `DANGER_ALLOW_AUDIT_PURGE` | `false` | Gate `DELETE /api/v1/data/activities` — must be `true` to truncate |
| `AUDIT_HASH_CHAIN` | `false` | Enable per-row `prevHash = sha256(prev.prevHash + row)` |
| `AUDIT_RETENTION_DAYS` | `365` | Daily sweep deletes rows older than this. `0` = never delete; `< 90` rejected at boot |
| `AUDIT_EXPORT_RATE_LIMIT` | `10` | Per (workspace × admin) CSV/NDJSON exports per 15-min window |

All four are documented in `backend/.env.example`.

---

## Immutability contract

By default, the admin route `DELETE /api/v1/data/activities` returns
`403 AUDIT_PURGE_DISABLED`. The audit log can only be truncated when
an operator explicitly sets `DANGER_ALLOW_AUDIT_PURGE=true` in the
environment.

This satisfies the SOC 2 CC7.2 immutability requirement: a misconfigured
or compromised admin account cannot wipe forensic evidence without a
deliberate operator action that leaves a deployment-config trail.

**When to flip it on:**
- Dev / CI environments running automated end-to-end suites
- Under an explicit incident-response playbook (with documented
  before/after backups of the `activities` table)

**Never** set this in a production deployment without an audit trail of
who flipped the env var and why.

---

## Retention policy

A daily cron task in `backend/src/scheduler.js` runs at `03:30 UTC` and
deletes activity rows whose `createdAt` is older than the configured
window. The task is armed at startup; if you change
`AUDIT_RETENTION_DAYS`, restart the server (or wait for the next cron
tick) to pick up the new value.

### Configuring the retention window

| `AUDIT_RETENTION_DAYS` | Behaviour |
|---|---|
| unset / empty | Default `365` (SOC 2 CC7.2 baseline) |
| `0` | Retention disabled — never delete |
| Any value `>= 90` | Daily sweep deletes rows older than that many days |
| Negative, non-numeric, or `1`–`89` | **Boot fails with a clear error message** |

The `< 90` floor enforces the SOC 2 / ISO 27001 minimum of 90 days for
security-relevant logs. Refusing to start with a too-low value is
deliberate: silently honouring it would put the deployment out of
compliance with no operator signal.

### Observing the sweep

When the sweep deletes rows, it logs once at INFO level:

```
[scheduler] Audit retention sweep deleted 142 row(s) older than 365 days
```

No log line means no rows matched the cutoff. Failures (e.g. DB locked)
log at ERROR with the exception message; the cron task continues to run
on its next schedule.

---

## Tamper-evidence (hash chain)

Set `AUDIT_HASH_CHAIN=true` to enable a cryptographic chain where every
audit row's `prevHash` column is computed as:

```
prevHash_i = sha256( prevHash_{i-1}  ++  JSON.stringify(rowMinusHash_i) )
```

`rowMinusHash` is every persisted column **except** `prevHash` itself,
in a deterministic key order. The hash is computed inside the same DB
transaction as the INSERT — concurrent emissions cannot race off the
same predecessor row.

### Verifying the chain

Admins can verify intact-ness from the UI ("Verify chain" button on
`/audit-log`) or via the API:

```
GET /api/v1/audit/verify
```

Response shapes:

| Shape | Meaning |
|---|---|
| `{ verified: true, chainDisabled: true }` | `AUDIT_HASH_CHAIN` is unset on the server — verification is a no-op |
| `{ verified: true, total: N }` | All `N` rows hash-link cleanly |
| `{ verified: false, firstBrokenRowId, total }` | A row's stored `prevHash` does not match the recomputed value — tampering detected; `firstBrokenRowId` points to the offending row |

The verifier and the INSERT path call the same `computePrevHash` helper,
so any drift between them surfaces immediately rather than silently
corrupting the chain.

### When to enable

Chain-mode is **off by default** because the chained INSERT path serialises
writes (each write must read the most-recent row's hash inside a
transaction). On high-volume workspaces this can become a bottleneck.

Enable it on:
- Low-volume, compliance-sensitive deployments (small QA team, SOC 2 audit prep)
- Staging environments mirroring a customer's SOC 2 control walk

Leave it off on high-throughput multi-tenant production unless you've
load-tested the contention impact.

### Caveat: retention + chain are mutually exclusive

If both `AUDIT_HASH_CHAIN=true` and `AUDIT_RETENTION_DAYS > 0` are set,
the server **refuses to boot** (see the validator in
`backend/src/index.js`). Retention purges would break the chain — the
first surviving row's `prevHash` was computed against a now-deleted
predecessor, so the verifier would walk from `previousHash = null` and
immediately report tampering on the next sweep. Failing fast at boot
beats silently producing an audit log that fails its own verification.

To use the hash chain, set `AUDIT_RETENTION_DAYS=0` (disable retention
entirely) and externalise long-term archival to your SIEM (see SIEM
integration below). If you need retention instead, leave
`AUDIT_HASH_CHAIN` unset.

---

## Meta-audit (audits of audits)

Every read of the workspace audit log emits its own row, satisfying
PCI-DSS 10.2.6 and SOC 2 CC7.2 (which require that "viewing audit data
is itself an audited event"):

| Route call | Emits |
|---|---|
| `GET /workspaces/:id/audit-log` (JSON browse) | `audit.read` |
| `GET /workspaces/:id/audit-log?format=csv` | `audit.export` |
| `GET /workspaces/:id/audit-log?format=ndjson` | `audit.export` |

The emitted row's `meta` captures the full filter shape:

```json
{
  "format": "csv",
  "rowCount": 47,
  "filters": {
    "userId": "U-12",
    "types": ["auth.login", "auth.login.failed"],
    "dateFrom": "2026-01-01T00:00:00.000Z",
    "dateTo": null,
    "ipAddress": null,
    "cursor": null,
    "limit": 200
  }
}
```

So a SOC 2 reviewer can answer "who pulled which window of the audit log,
when, in which format?" purely from the audit log itself. Bulk exfiltration
of the compliance trail is impossible without leaving a trace.

---

## Anti-exfiltration export rate limit

Bulk CSV / NDJSON exports are rate-limited per (workspace × admin):

- **Default:** 10 exports per 15-minute window
- **Configurable:** `AUDIT_EXPORT_RATE_LIMIT` env var
- **Scope:** only counts `?format=csv` and `?format=ndjson` — JSON browsing is exempt
- **Response on trip:** `429 AUDIT_EXPORT_RATE_LIMITED` with the rate-limiter's friendly message

Generous enough for legitimate evidence requests (SOC 2 control walks,
customer DSARs); tight enough that a script pulling the entire table
trips both the rate-limit logs **and** the meta-audit `audit.export`
emissions in lockstep, producing a clear anti-exfiltration signal.

---

## Auth events captured

SEC-007 added eight password-path authentication event types. Every
event captures the actor's `userId`, `userName`, `ipAddress` (from
`req.ip`, honouring `app.set('trust proxy')`), `userAgent` (from
`req.get('user-agent')`), and a `meta` blob with event-specific context:

| Event type | Triggered by | `meta` |
|---|---|---|
| `auth.login` | Successful password / OAuth / MFA login | — |
| `auth.login.failed` | Wrong password (known or unknown user) | — |
| `auth.logout` | `POST /api/v1/auth/logout` | — |
| `auth.password.reset` | Successful `/reset-password` (token-based) | — |
| `auth.role.change` | `PATCH /workspaces/current/members/:userId` | `{ from, to, changedBy, changedByName }` |
| `auth.api_key.create` | `POST /api/v1/settings` (provider API key save) | `{ provider, providerName }` — **raw key never logged** |
| `auth.api_key.revoke` | `DELETE /api/v1/settings/:provider` | `{ provider }` |
| `auth.session.revoke` | Server-initiated session termination | `{ jti, reason }` — e.g. `mfa.disabled`, `mfa.recovery_codes_regenerated`, `webauthn.credential_removed` |

The eight existing `auth.mfa.*` event types (SEC-004) continue to fire
on the MFA-specific paths.

### Trust-proxy requirement

For accurate IP capture behind a load balancer / reverse proxy, ensure
`app.set('trust proxy', ...)` is configured to match your infrastructure
(see `backend/src/middleware/appSetup.js`). Without it, every captured
IP will be the proxy's address — useless for forensic session
reconstruction.

---

## SIEM integration shape

SEC-007 ships the **storage and replay infrastructure** for forwarding
every audit event to a SIEM (Splunk HEC, Datadog Logs Intake, Elastic
ingest, syslog-over-HTTPS, etc.). The transport layer itself —
`dispatchSiemEvent` in `backend/src/utils/notifications.js` — is a
follow-up PR. Until then, the SIEM-replay route returns
`503 SIEM_NOT_CONFIGURED`.

### What's already shipped

- `audit_dlq` table (migration 031) — stores events the SIEM forwarder
  failed to deliver after exhausting its retry budget
- `backend/src/database/repositories/auditDlqRepo.js` — `enqueue`, `list`,
  `getById`, `incrementAttempts`, `remove`, `countByWorkspace`
- Admin routes:
  - `GET /api/v1/workspaces/:workspaceId/audit-log/dlq` — list DLQ rows
  - `POST /api/v1/workspaces/:workspaceId/audit-log/dlq/:dlqId/replay` — re-dispatch
- `AuditLog.jsx` DLQ inspector with per-row replay button

### Event payload shape

When the forwarder lands, it will POST one event per row in NDJSON form:

```
POST <SIEM target URL>
Content-Type: application/x-ndjson
X-Sentri-Audit-Signature: sha256=<hex(hmac(secret, body))>

{"id":"ACT-42","type":"auth.login","userId":"U-1","userName":"alice","workspaceId":"WS-1","createdAt":"2026-05-16T...","ipAddress":"203.0.113.7","userAgent":"Mozilla/5.0 ...","meta":null}
```

### Retry semantics

- 3 attempts at 1s / 2s / 4s exponential backoff
- 5xx, network errors, and connect timeouts are retried
- 4xx (except 408 / 429) are not retried — they indicate a config issue at the SIEM target
- Persistent failure after 3 attempts → row lands in `audit_dlq` with
  `attempts: 1, lastError: <message>, createdAt: <ISO>`
- An admin can replay via `POST .../dlq/:dlqId/replay`; success removes
  the row, failure bumps `attempts` and refreshes `lastError`

### HMAC signature

`X-Sentri-Audit-Signature: sha256=hex(hmac_sha256(workspace_secret, ndjson_body))`

Verify on the SIEM target side to confirm authenticity. The workspace's
secret is configured via the per-workspace SIEM config (admin-only,
encrypted at rest via `credentialEncryption.js`).

### When `dispatchSiemEvent` is missing

Pre-Part-C state (the current code):

- `auditDlqRepo.enqueue()` works and can be called by any future
  forwarder integration
- `POST .../dlq/:dlqId/replay` returns `503 SIEM_NOT_CONFIGURED` with a
  clean error code — the UI surfaces this as an info notification
  ("SIEM forwarding isn't configured on this server yet") rather than
  a generic error

Once the forwarder ships, admins can replay queued events with no
further changes to the DLQ table, repo, or routes.

---

## Operator runbook

### "Is my audit log intact?"

1. Open `/audit-log` (admin only)
2. Click **Verify chain**
3. If the banner shows `✓ Chain verified · N rows` → integrity confirmed
4. If it shows `Chain broken at row ACT-...` → preserve the database
   immediately and investigate (the row pointed to is the first
   one whose `prevHash` doesn't match the recomputed value)
5. If it shows `Hash chain is disabled` → set `AUDIT_HASH_CHAIN=true`
   in your env and restart to enable tamper-evidence going forward
   (existing rows will have `prevHash = NULL` until they roll off the
   retention window)

### "I need a full audit dump for a SOC 2 control walk"

1. Open `/audit-log`
2. Filter by `dateFrom` / `dateTo` covering the audit window
3. Click **Export NDJSON** (preserves exact field shapes) or **Export CSV**
4. The browser downloads `sentri-audit-log-YYYY-MM-DD.{csv|ndjson}`
5. The export itself emits an `audit.export` row, so the auditor can
   verify your evidence-gathering action is itself audited

### "Production needs to truncate the activity log under incident response"

1. Document the incident response decision in your team's playbook /
   runbook with the responsible operator's name
2. Take a `pg_dump` / `sqlite3 .dump activities` snapshot
3. Set `DANGER_ALLOW_AUDIT_PURGE=true` in env and restart
4. Call `DELETE /api/v1/data/activities` via the admin UI's Systems page
5. **Immediately** revert `DANGER_ALLOW_AUDIT_PURGE=false` and restart

The env-var flip leaves a deployment-config trail; the
`accountRepo.deleteAccount` path is a different, less destructive
operation that only affects one user's data.

---

## Standards mapping

| Sentri control | SOC 2 | ISO 27001 | PCI-DSS |
|---|---|---|---|
| 8 `auth.*` events with IP + UA | CC6.1 (logical access) | A.8.16 (monitoring) | 10.2 |
| Workspace-scope assertion | CC6.6 (logical access) | A.5.18 (logical access) | 7.2 |
| Anti-exfiltration export limiter | CC6.7 (data transfer) | A.8.12 (data leakage) | — |
| `prevHash` chain + verification | CC7.1 (system integrity) | A.5.36 (compliance) | 10.5.2 |
| Retention floor 90 days | CC7.2 (system monitoring) | A.8.15 (logging) | 10.5.1 |
| Immutability env gate | CC7.2 | A.8.15 | 10.5.2 |
| Meta-audit (`audit.read` / `.export`) | CC7.2 | A.8.15 | **10.2.6** |
| DLQ + SIEM forwarder (Part C) | CC7.2 | A.8.16 | 10.5.4 |
