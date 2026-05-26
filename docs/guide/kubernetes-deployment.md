# Kubernetes deployment (INF-009)

Sentri ships a first-class Helm chart at `helm/sentri/`. The chart deploys
the backend HTTP server, the BullMQ worker, an in-cluster Postgres
StatefulSet (with persistent volume), an in-cluster Redis Deployment, an
Ingress, ConfigMap, Secret, and a worker HorizontalPodAutoscaler driven by
the `app_queue_depth` Prometheus gauge.

## Prerequisites

- Kubernetes 1.27+ (the chart is validated against 1.30 in CI via
  `kubeconform --strict`).
- Helm 3.12+.
- An Ingress controller (e.g. `ingress-nginx`) installed in the cluster.
- A `StorageClass` that supports `ReadWriteOnce` PVCs.
- **For the autoscaler:** the Prometheus Adapter installed and configured
  to expose the `app_queue_depth` custom metric to the HPA API. Without it,
  the HPA stays at `minReplicas` — the worker still runs, the autoscaler
  just doesn't scale.

## Quick start

```bash
helm install sentri ./helm/sentri \
  --set ingress.host=sentri.example.com \
  --set secrets.JWT_SECRET="$(openssl rand -hex 32)" \
  --set secrets.ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  --set secrets.POSTGRES_PASSWORD="$(openssl rand -hex 24)"

kubectl wait --for=condition=Ready pod -l app=backend --timeout=90s
kubectl wait --for=condition=Ready pod -l app=worker  --timeout=90s
kubectl wait --for=condition=Ready pod -l app=postgres --timeout=90s
```

Once all pods are `Ready`, validate the probes:

```bash
kubectl port-forward svc/sentri-backend 3001:3001
curl -fsS http://localhost:3001/health          # → 200 (liveness — process alive, no dep checks)
curl -fsS http://localhost:3001/api/v1/health   # → 200 { ok: true, checks: { database: true, redis: true } }

kubectl port-forward deploy/sentri-worker 3002:3002
curl -fsS http://localhost:3002/livez           # → 200 (liveness — process alive)
curl -fsS http://localhost:3002/healthz         # → 200 { ok: true } (readiness — Redis reachable)
```

### Probe split rationale

The chart deliberately uses **different endpoints for readiness vs liveness**:

| Probe | Backend path | Worker path | Behavior on failure |
|---|---|---|---|
| `readinessProbe` | `/api/v1/health` | `/healthz` | Pod removed from Service endpoints; no restart |
| `livenessProbe` | `/health` | `/livez` | Pod killed and restarted by kubelet |

Readiness probes check downstream dependencies (Postgres + Redis) so kubelet stops routing traffic to a pod that can't serve requests. Liveness probes only check that the Node process is responsive — restarting the pod doesn't fix a Redis outage, it just amplifies a transient blip into a thundering-herd restart loop across every replica.

## Services created by the chart

| Service           | Type      | Port  | Purpose                                            |
|-------------------|-----------|-------|----------------------------------------------------|
| `sentri-backend`  | ClusterIP | 3001  | HTTP traffic + ingress backend target.             |
| `sentri-postgres` | Headless  | 5432  | StatefulSet stable network identity.               |
| `sentri-redis`    | ClusterIP | 6379  | BullMQ queue connectivity (omitted when `redis.cluster.enabled=true`). |

## Configuration

All knobs live in `helm/sentri/values.yaml`. Common overrides:

- `backend.replicas` / `worker.replicas` — replica counts (HPA owns the
  worker's runtime count when `autoscaling.enabled=true`).
- `postgres.storage` — PVC size for the StatefulSet (default `10Gi`).
- `postgres.user` / `postgres.database` — DB user + database name; must
  match `env.DATABASE_URL`.
- `redis.cluster.enabled` — set to `true` to skip rendering the in-cluster
  Redis Deployment + Service and point `REDIS_URL` at an external Redis
  Cluster (e.g. AWS ElastiCache).
- `autoscaling.{minReplicas,maxReplicas,targetQueueDepth}` — HPA bounds
  and the `app_queue_depth` target the Prometheus Adapter exposes.

## Graceful shutdown

Both Deployments set `terminationGracePeriodSeconds: 60` to align with
MAINT-013's drain timeout. A `kubectl delete pod` or rolling update
flips the readiness probe red, ingress stops routing to the deleted pod,
SIGTERM triggers the in-process drain (`backend/src/index.js`,
`backend/src/worker.js`), and the new pod's `/api/v1/health` returns 200
before traffic resumes.

## Disaster recovery

Nightly `pg_dump -Fc` → S3 backups are configured via
`.github/workflows/nightly-backup.yml`. See
[Disaster recovery](./disaster-recovery.md) for the restore playbook,
RTO/RPO targets, and the `helm rollback` runbook for failed releases.
