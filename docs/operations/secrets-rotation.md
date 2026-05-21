# Master-key rotation — `SENTRI_MASTER_KEY`

> Operator runbook for rotating the AES-256-GCM master key that encrypts
> every `provider_routes.apiKeyEncrypted` BLOB at rest (B1.4).

## When to rotate

- **Scheduled** — annually, as a defence-in-depth control.
- **Forced** — within 24 h of any of:
  - A workstation that ever held the key being lost or compromised.
  - A team member with master-key access leaving the company.
  - A suspected DB-dump leak (rotate the master key AND every wrapped
    provider API key — see `docs/operations/credential-rotation.md`).

`SENTRI_MASTER_KEY` is the **only** input to the encryption helper in
`backend/src/aiProvider/secrets.js`. Losing it means every encrypted
provider key is unrecoverable — back the value up to the same secrets
store you use for the DB master credential (1Password, AWS Secrets
Manager, HashiCorp Vault, etc.).

## Pre-rotation checklist

- [ ] You have shell access to every backend instance (web, worker,
      scheduler) that mounts the production DB.
- [ ] You have the **current** `SENTRI_MASTER_KEY` value in hand (the
      rotation script needs both old and new keys live simultaneously).
- [ ] A full DB backup taken within the last hour. Rotation rewrites
      every `provider_routes` row; if the migration script fails
      mid-flight, restoring from backup is the recovery path.
- [ ] No active crawls or test runs in flight (rotation will invalidate
      the in-memory plaintext cache; queued AI calls will re-decrypt
      transparently, but it's cleaner to drain first).

## Rotation procedure

```bash
# 1. Generate the new master key.
NEW_KEY=$(openssl rand -base64 32)
echo "NEW_KEY=$NEW_KEY"   # back this up before continuing

# 2. Run the dual-key re-encrypt script with the OLD key on stdin
#    and the NEW key in the env. The script reads every provider_routes
#    row, decrypts with the OLD key, re-encrypts with the NEW key, and
#    writes back inside one transaction per row.
SENTRI_MASTER_KEY_OLD=$CURRENT_KEY \
SENTRI_MASTER_KEY=$NEW_KEY \
  node backend/scripts/rotate-master-key.js
```

> The dual-key script (`backend/scripts/rotate-master-key.js`) is
> tracked separately and ships alongside B1.4. It accepts `--dry-run`
> to verify every row decrypts cleanly under the old key before any
> write happens.

**3. Update the env in your secrets store** so every backend instance
   picks up `SENTRI_MASTER_KEY=$NEW_KEY` on next restart.

**4. Rolling restart** every backend instance. The plaintext cache is
   process-local, so each restart wipes its cache and re-decrypts under
   the new key. There is **no** API to clear the cache without a
   restart by design — the cache key is `routeId`, and the cache values
   stay valid across a master-key rotation as long as the encrypted
   blob hasn't changed.

**5. Verify** at least one route per provider family:

```bash
curl -X POST https://$SENTRI_HOST/api/v1/settings/provider-routes/$ROUTE_ID/probe \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# Expect: { ok: true, provider: "anthropic", ... }
```

**6. Securely delete** the old `SENTRI_MASTER_KEY` from your secrets
   store. Audit-log this with the date and the operator's name —
   forensic investigations need to know which key was active for any
   given ciphertext.

## Rollback

If the re-encrypt script fails partway through:

1. Restore the pre-rotation DB backup. `provider_routes` is the only
   table touched.
2. Keep `SENTRI_MASTER_KEY` as the **old** key in env (do NOT update
   secrets store until rotation succeeds).
3. Diagnose the failure with `--dry-run` against the restored backup
   before re-attempting.

## What `secrets.js` will NOT recover from

- **Master key lost without a backup** — every encrypted provider key
  is gone. Operators must manually re-enter every API key via the
  Settings UI. There is no recovery path; AES-256-GCM is deliberately
  not key-recoverable.
- **Master key length wrong** — `secrets.js` fails fast at import time
  in production (`ERR_MASTER_KEY_INVALID`). The backend won't start
  until the env is fixed.
- **Master key missing in production** — same: import-time crash with
  `ERR_MASTER_KEY_MISSING`. There is no `dev-fallback-in-prod`
  shortcut by design.

## Audit trail

Every key rotation MUST be logged in two places:

- The `provider_route_audit` table via the normal `rotate_key` action
  emitted by `providerRouteRepo.upsert`. The dual-key script writes
  one row per route as it re-encrypts.
- A free-form ops journal (Notion / Confluence / etc.) capturing the
  operator name, timestamp, reason, and a SHA-256 fingerprint of the
  **old** key (so a future forensic review can correlate ciphertexts
  to keys without storing the keys themselves).
