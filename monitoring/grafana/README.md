# Sentri — Grafana dashboards

§11.2 / audit follow-up — operator-facing Grafana dashboards for the metrics
defined in `backend/src/utils/metrics.js` and the alerts in
`monitoring/prometheus/alerts.yml`.

## Files

| File | Description |
|---|---|
| `sentri-overview.json` | Top-level operations dashboard. RED (Rate / Error / Duration) on the API + run pipeline, BullMQ queue depth, AI provider health, AI cost / cache hit-rate, Node.js runtime gauges. Every panel is paired with the alert it monitors so an on-call engineer can click straight from an alert to the matching panel. |

## Import

In Grafana UI: **Dashboards → New → Import** → upload the JSON file, then
select your Prometheus datasource for the `${DS_PROMETHEUS}` input.

Alternatively, file-provision the dashboards alongside the chart via the
[Grafana sidecar pattern](https://grafana.com/docs/grafana/latest/administration/provisioning/#dashboards):

```yaml
# grafana provisioning config
apiVersion: 1
providers:
  - name: sentri
    folder: Sentri
    type: file
    options:
      path: /var/lib/grafana/dashboards/sentri
```

…then mount this directory into the Grafana pod at that path.

## Metric → Alert → Panel pairing

The overview dashboard intentionally mirrors the alert grouping from
`monitoring/prometheus/alerts.yml`. Each panel's title includes the alert
name it corresponds to so the operator can navigate by alert label.

| Alert | Panel |
|---|---|
| `HighHttpErrorRate` | API — 5xx error rate |
| `HighApiLatencyP99` | API — Request latency p50 / p95 / p99 |
| `HighRunFailureRate` | Runs — Failure ratio |
| `QueueDepthSaturated` | Queue — Depth by state |
| `AiProviderHighErrorRate` / `AiProviderAuthFailures` | AI — Error rate by reason |
| `AiProviderHighLatencyP99` | AI — p99 latency by route |
| `EventLoopLagHigh` | Runtime — Event loop lag |

When a new alert is added to `alerts.yml`, the contributing PR should add
a matching panel here and update the table above.
