# Disaster recovery (INF-009)

- **RTO target:** <4 hours
- **RPO target:** <24 hours

## Backup layout
- `s3://<bucket>/daily/YYYY-MM-DD.dump` — nightly `pg_dump -Fc` (custom format)
- `s3://<bucket>/monthly/YYYY-MM.dump` — first-of-month snapshot, same format
- Keep 30 daily and 12 monthly snapshots (apply via bucket lifecycle policy).

## Restore
1. Provision fresh Postgres StatefulSet PVC (`helm install …` or `kubectl scale --replicas=0` on a stuck one then `kubectl delete pvc data-sentri-postgres-0` and re-up).
2. Download the snapshot: `aws s3 cp s3://<bucket>/daily/<YYYY-MM-DD>.dump backup.dump`.
3. Restore with `pg_restore` (custom-format only — plain-SQL would need `psql`):
   ```bash
   pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" backup.dump
   ```
4. Restart Sentri backend/worker: `kubectl rollout restart deploy/sentri-backend deploy/sentri-worker`.

## Rollback failed release
- `helm rollback sentri <revision> --wait`
