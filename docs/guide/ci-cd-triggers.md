# CI/CD Triggers

Sentri can be triggered directly from your CI/CD pipeline so regression tests run automatically on every push, merge, or deployment.

## How It Works

1. **Create a trigger token** — one per project, from the **Trigger** tab in Project Detail.
2. **`POST /api/projects/:id/trigger`** with the token as a Bearer header — returns `202 Accepted` immediately with `{ runId, statusUrl }`.
3. **Poll `statusUrl`** until `status` is no longer `"running"`.
4. Optionally pass a `callbackUrl` in the request body to receive a POST with the run summary when it finishes.

## Creating a Token

Navigate to your project → **Trigger** tab → **New token**.

The plaintext token is shown **exactly once**. Copy it and store it as a CI secret (e.g. `SENTRI_TOKEN`). Only the SHA-256 hash is stored in the database — the plaintext cannot be retrieved again.

::: warning
Treat trigger tokens like passwords. Never commit them to your repository.
:::

## Token Management

| Action | Endpoint | Auth |
|---|---|---|
| List tokens | `GET /api/projects/:id/trigger-tokens` | JWT (user session) |
| Create token | `POST /api/projects/:id/trigger-tokens` | JWT (user session) |
| Revoke token | `DELETE /api/projects/:id/trigger-tokens/:tid` | JWT (user session) |

Token management endpoints require a normal user session (JWT). Only the trigger endpoint itself accepts Bearer tokens.

## Trigger Endpoint

```
POST /api/projects/:id/trigger
Authorization: Bearer <token>
Content-Type: application/json

{
  "dialsConfig": { "parallelWorkers": 2 },
  "callbackUrl": "https://ci.example.com/hooks/sentri"
}
```

**Response `202 Accepted`:**

```json
{ "runId": "RUN-42", "statusUrl": "https://sentri.example.com/api/runs/RUN-42" }
```

### Error Codes

| Code | Reason |
|---|---|
| 400 | No approved tests — crawl and approve tests first |
| 401 | Missing or invalid Bearer token |
| 403 | Token belongs to a different project |
| 404 | Project not found |
| 409 | Another run already in progress |
| 429 | Rate limit exceeded |

## GitHub Actions Example

```yaml
# .github/workflows/sentri.yml
name: Sentri regression

on:
  push:
    branches: [main]

jobs:
  sentri:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Sentri test run
        id: trigger
        run: |
          response=$(curl -sf -X POST \
            -H "Authorization: Bearer ${{ secrets.SENTRI_TOKEN }}" \
            -H "Content-Type: application/json" \
            "https://your-sentri-instance.com/api/projects/PRJ-1/trigger")
          echo "run_id=$(echo $response | jq -r .runId)" >> $GITHUB_OUTPUT
          echo "status_url=$(echo $response | jq -r .statusUrl)" >> $GITHUB_OUTPUT

      - name: Wait for run to complete
        run: |
          status_url="${{ steps.trigger.outputs.status_url }}"
          for i in $(seq 1 60); do
            status=$(curl -sf "$status_url" | jq -r .status)
            echo "Run status: $status"
            [ "$status" != "running" ] && break
            sleep 10
          done
          [ "$status" = "completed" ] || exit 1
```

## GitLab CI Example

```yaml
# .gitlab-ci.yml
sentri:
  stage: test
  script:
    - |
      response=$(curl -sf -X POST \
        -H "Authorization: Bearer $SENTRI_TOKEN" \
        -H "Content-Type: application/json" \
        "https://your-sentri-instance.com/api/projects/PRJ-1/trigger")
      STATUS_URL=$(echo $response | jq -r .statusUrl)
      for i in $(seq 1 60); do
        STATUS=$(curl -sf "$STATUS_URL" | jq -r .status)
        echo "Run status: $STATUS"
        [ "$STATUS" != "running" ] && break
        sleep 10
      done
      [ "$STATUS" = "completed" ]
```

## cURL (Direct)

```bash
curl -X POST \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  "https://your-sentri-instance.com/api/projects/PRJ-1/trigger"
```

## Callback URL

Pass `callbackUrl` in the trigger request body to receive a POST when the run finishes:

```json
{
  "callbackUrl": "https://ci.example.com/hooks/sentri"
}
```

Sentri will POST a JSON summary (best-effort, 10s timeout):

```json
{
  "runId": "RUN-42",
  "status": "completed",
  "passed": 15,
  "failed": 0,
  "total": 15
}
```

## Security Notes

- Tokens are stored as **SHA-256 hashes** — the plaintext is never persisted.
- Tokens are **project-scoped** — a token for Project A cannot trigger Project B.
- When a project is deleted, all its trigger tokens are **immediately hard-deleted** (not soft-deleted).
- The trigger endpoint is rate-limited by the `expensiveOpLimiter` (20 req/hr per IP).
