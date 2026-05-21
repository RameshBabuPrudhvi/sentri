# Disaster recovery (INF-009)

- **RTO target:** <4 hours
- **RPO target:** <24 hours

## Backup layout
- `s3://<bucket>/daily/YYYY-MM-DD.sql`
- `s3://<bucket>/monthly/YYYY-MM.sql`
- keep 30 daily and 12 monthly snapshots (bucket lifecycle policy)

## Restore
1. Provision fresh Postgres StatefulSet PVC.
2. Download snapshot.
3. Run: `pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" backup.sql`
4. Restart Sentri backend/worker.

## Rollback failed release
- `helm rollback sentri <revision> --wait`
