# Server-side coverage capture (AUTO-009h)

Sentri's browser coverage (AUTO-009) only captures the JavaScript that Playwright
executes inside the browser. **API tests run no browser at all** — they hit your
server endpoints via Playwright's `request.newContext()` and the V8 collector
records nothing. AUTO-009h fills that gap by snapshotting your SUT's
Istanbul / NYC coverage object before and after each API test, then attributing
the diff to that specific test.

This is **opt-in per project** and **off by default**. No competitor outside the
enterprise SaaS tier (Codecov, Bullseye) does this for self-hosted SUTs.

## TL;DR

1. Start your SUT under `c8 --reporter=json` (or `nyc`).
2. Expose `GET /__coverage__` returning `global.__coverage__` as JSON.
3. Set `projects.serverCoverageEndpoint` to the URL via
   `PATCH /api/v1/projects/:id { serverCoverageEndpoint: "https://staging.example.com/__coverage__" }`.
4. Run any API test; Sentri snapshots the endpoint before/after and persists
   the diff into `runs.coverageSummary.topUncoveredFiles[]` with `layer: "server"`.

The Dashboard's Coverage panel will show a new **Browser / Server / Combined**
tab toggle.

## Two modes

### HTTP endpoint (preferred)

Most ergonomic for staging / preview environments. Mount a tiny route that
returns the live coverage object:

```js
// server.js — instrumented build
import express from "express";
const app = express();

// …your real routes…

if (process.env.NODE_ENV !== "production") {
  app.get("/__coverage__", (_req, res) => {
    res.json(global.__coverage__ || {});
  });
}
app.listen(3000);
```

Start the SUT with c8:

```bash
npx c8 --reporter=json node server.js
```

Configure Sentri:

```bash
curl -X PATCH https://sentri.example.com/api/v1/projects/PRJ-xxx \
  -H "Content-Type: application/json" \
  -d '{ "serverCoverageEndpoint": "https://staging.example.com/__coverage__" }'
```

### File-watch (shared filesystem)

For Docker Compose / Kubernetes setups where the SUT writes coverage to a
shared volume and an HTTP endpoint isn't desirable:

```yaml
# docker-compose.yml
services:
  sut:
    image: my-app:instrumented
    volumes:
      - coverage-vol:/var/coverage
    command: ["c8", "--reporter=json", "--report-dir=/var/coverage", "node", "server.js"]
  sentri-backend:
    image: sentri/backend
    volumes:
      - coverage-vol:/var/coverage:ro
volumes:
  coverage-vol:
```

Configure with a `file://` URL (must be absolute):

```bash
curl -X PATCH https://sentri.example.com/api/v1/projects/PRJ-xxx \
  -H "Content-Type: application/json" \
  -d '{ "serverCoverageEndpoint": "file:///var/coverage/coverage-final.json" }'
```

The SUT must rewrite the file between API tests (c8's default behaviour). The
diff is computed by Sentri so a stale file just produces empty diffs.

## Security implications — read this before exposing /__coverage__

Exposing your SUT's coverage object **leaks the full source-file layout** of
your application. The JSON includes absolute paths (`/app/src/auth/login.ts`),
line/column positions for every statement, and source-content hashes. An
attacker who can hit `/__coverage__` learns:

- Your directory structure (informs targeted exploitation).
- Which code paths are well-tested vs. dead code (the well-tested branches are
  the ones an attacker will probe last).
- Source-content hashes that reveal whether you're running a known-vulnerable
  version.

**Do not enable in production.** Operator checklist:

- [ ] Gate behind `process.env.NODE_ENV !== "production"` (as in the example).
- [ ] Bind the staging SUT to an internal-only network ACL (VPC peering,
      WireGuard, or an authenticated reverse proxy).
- [ ] Add auth in front of `/__coverage__` if it's reachable from the public
      internet. Sentri's SSRF guard will reject loopback/RFC1918 addresses, so
      the staging URL must be publicly resolvable — but it doesn't have to be
      publicly accessible.
- [ ] Remove or password-gate the route in any image that ships to prod.

## How the diff works

For every API test, Sentri:

1. Calls `GET /__coverage__` (or reads the file) — call this `before`.
2. Executes the API test via `runApiTestCode`.
3. Calls `GET /__coverage__` again — `after`.
4. Diffs the two Istanbul `FileCoverage` objects: for each file, counts the
   statement / branch arm / function IDs that went from `count === 0` in
   `before` to `count > 0` in `after`.
5. Persists the per-file diff onto `result.serverCoverage`.

The aggregator (`pipeline/coverageAggregator.js`) then merges all per-test
diffs into the run-level `coverageSummary.topUncoveredFiles[]` with
`layer: "server"`.

## Limitations

- **Single-threaded SUT assumption.** If your SUT serves concurrent traffic
  from other clients during the test, their coverage will leak into the diff.
  Run the instrumented build in a dedicated environment.
- **Branch-arm resolution requires c8 ≥ 9.** Earlier versions report only
  statement-level data; branch counts will be 0 in the diff.
- **Source-map resolution — two paths, both supported.**
  Sentri's aggregator surfaces the path each file appears under in
  `global.__coverage__`. There are two ways to get original TypeScript /
  source paths on the Dashboard:

  1. **Preferred — let c8 do it.** Start the SUT with `c8 --source-map`
     (c8 ≥ 7.10) or ensure `tsc --sourceMap` writes `.map` files next to
     the compiled `.js`. c8 then reads the inline `//# sourceMappingURL=`
     pragma at instrumentation time and emits already-resolved paths
     (`/app/src/auth/login.ts`). Lowest overhead and zero configuration
     on Sentri's side.

  2. **Fallback — Sentri-side resolution via `sourcemapBaseUrl`.** When
     the SUT runs c8 without source-map handling (paths look like
     `/app/dist/server.js`) you can point Sentri at the maps via the
     same `project.sourcemapBaseUrl` field that browser-side coverage
     uses. Sentri's aggregator probes `<sourcemapBaseUrl>/<filename>.map`
     for each `.js` / `.mjs` / `.cjs` path in the diff and rewrites it
     to the original source. SSRF-guarded; LRU-cached (1h TTL); silently
     no-ops when the map isn't reachable.

  Quick check: `cat /tmp/coverage.json | jq 'to_entries[0].value.path'`
  — `.ts` paths mean option 1 is working. `.js` / `dist/` paths mean
  the SUT needs option 1 enabled, or you can configure option 2.
- **Snapshot overhead.** Each API test costs 2 × `GET /__coverage__` round
  trips. On a 100-test API run against a 50-MB coverage object, that's ~10s
  of extra wall-clock. Set `serverCoverageEndpoint: null` when you don't need
  the data (e.g. CI smoke runs).

## Acceptance test

Spin up a tiny instrumented Express app:

```js
// server.js
import express from "express";
const app = express();
app.get("/hello", (_req, res) => res.json({ ok: true }));
app.get("/__coverage__", (_req, res) => res.json(global.__coverage__ || {}));
app.listen(3000);
```

```bash
npx c8 --reporter=json node server.js
```

Configure Sentri's project with `serverCoverageEndpoint: "http://localhost:3000/__coverage__"`
(use `ALLOW_PRIVATE_URLS=true` for local dev — see SSRF guard).

Run an API test that hits `/hello`. Open the Dashboard's Coverage panel and
click the **Server** tab. You should see `server.js` in the top-uncovered list
with statement counts reflecting exactly what `/hello` exercised.
