# Sentri E2E Execution Report

Generated: 2026-04-26T06:47:57.388Z

## 1. Functional Coverage Report

| Flow | Status | Notes |
|---|---|---|
| health endpoint responds | Tested | Validated in Playwright run |
| register creates user and login is blocked until verification | Tested | Validated in Playwright run |
| login negative path with bad password | Tested | Validated in Playwright run |
| verify account, login, project+test CRUD happy path | Tested | Validated in Playwright run |
| negative validations for project/test inputs | Tested | Validated in Playwright run |
| session security: logout revokes access and missing CSRF blocks mutation | Tested | Validated in Playwright run |
| login page renders core controls | Partially Tested | Skipped due environment/runtime gating |
| invalid credentials show an error state | Partially Tested | Skipped due environment/runtime gating |

**Summary:** 6 passed, 0 failed, 2 skipped.

## 2. Issues Found

### login page renders core controls
- **Severity:** Medium
- **Steps:** Run the Playwright suite and execute this flow.
- **Expected:** Flow should pass consistently.
- **Actual:** Flow status was `skipped`.
- **Screenshot:** Not captured in this report generator output.

### invalid credentials show an error state
- **Severity:** Medium
- **Steps:** Run the Playwright suite and execute this flow.
- **Expected:** Flow should pass consistently.
- **Actual:** Flow status was `skipped`.
- **Screenshot:** Not captured in this report generator output.

## 3. Framework Gaps

- UI flows depend on environment provisioning (frontend runtime + browser binaries).
- E2E scenarios are currently smoke-to-medium depth; advanced exploratory UX journeys can be expanded.
- Reporter currently summarizes status but does not yet attach trace/screenshot links per case.

## 4. Automation Maturity Score

- **Maintainability:** 8/10
- **Scalability:** 7/10
- **Reliability:** 7/10

## 5. Improvement Recommendations

### Functional
- Add deeper UI journeys across Dashboard, Projects, Tests, Runs, and Settings in browser-enabled environments.
### Framework
- Add shared page objects/component models to reduce selector duplication.
### CI/CD
- Keep dedicated UI E2E job and add flaky-retry/quarantine strategy for non-deterministic UI tests.
### Developer Experience
- Add npm scripts for targeted subsets (`e2e:ui`, `e2e:api`) and artifact upload helpers.
