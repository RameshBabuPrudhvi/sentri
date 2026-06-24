/**
 * B3 (AUDIT-ROADMAP Bundle 3) — Reviewer-collapse contract pins.
 *
 * Covers:
 *   1. `detectReviewerCollapse(workspaceId)` returns `{ collapsed: false }`
 *      when no workspaceId is passed (smoke-test / standalone CLI path).
 *   2. `runReviewerAuthorLoop({ reviewerCollapsed: true })` does not
 *      break the loop's terminal contract — structural regression bait
 *      so a future refactor that drops the option fails loudly.
 *   3. `agentReviewerCollapsedTotal` Prometheus counter is registered
 *      and bumpable.
 *
 * Canonical pattern per AGENTS.md § "Use `createTestContext().createTestRunner()`":
 * each case wrapped in try/catch via the shared runner so a thrown
 * assertion produces a per-case ✗ line + non-zero exit, never a
 * silent CI hang.
 *
 * Full crawler.js pre-run gate integration is exercised by the
 * existing `agent-pipeline-envelope.test.js` / `autonomous-mode-e2e.test.js`
 * suites; this file pins the leaf-level helper + loop contract.
 */
import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";
import { detectReviewerCollapse } from "../src/aiProvider/reviewerCollapse.js";
import { runReviewerAuthorLoop } from "../src/aiProvider/agentLoop.js";
import { register, agentReviewerCollapsedTotal } from "../src/utils/metrics.js";

const ctx = createTestContext();
const runner = ctx.createTestRunner();

async function main() {
  await runner.test("detectReviewerCollapse — null workspaceId returns collapsed:false (fail-open)", () => {
    const info = detectReviewerCollapse(null);
    assert.equal(info.collapsed, false);
    assert.equal(info.routeId, null);
    assert.equal(info.model, null);
  });

  await runner.test("detectReviewerCollapse — undefined workspaceId returns collapsed:false", () => {
    const info = detectReviewerCollapse(undefined);
    assert.equal(info.collapsed, false);
  });

  await runner.test("detectReviewerCollapse — non-existent workspaceId returns collapsed:false (no rows, no throw)", () => {
    // Fail-open contract: a workspace that doesn't exist must not be
    // treated as collapsed (would otherwise force every standalone /
    // smoke-test path through heuristic-only review).
    const info = detectReviewerCollapse(`ws-nonexistent-${Date.now()}`);
    assert.equal(info.collapsed, false);
  });

  await runner.test("runReviewerAuthorLoop honours reviewerCollapsed:true without breaking terminal contract", async () => {
    const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
      runAuthor: async ({ artifact }) => artifact,
      runReviewer: async () => ({ intent: "accept" }),
      reviewerCollapsed: true,
    });
    assert.equal(out.outcome, "accept");
    assert.equal(out.round, 0);
    assert.equal(out.roundsCompleted, 1);
  });

  await runner.test("runReviewerAuthorLoop with reviewerCollapsed:true bypasses runReviewer entirely (zero LLM cost)", async () => {
    // Spec contract at `docs/roadmap/AUDIT-ROADMAP.md:476-480`:
    // "Skip all LLM reviewer calls" when collapsed. The loop must
    // NOT invoke the caller-supplied `runReviewer` — even a heuristic
    // reviewer is replaced with a synthetic auto-accept. Pre-fix the
    // option only suppressed the in-loop advisory; the LLM/heuristic
    // reviewer still ran, defeating the cost-skip contract.
    let reviewerCalls = 0;
    const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
      runAuthor: async ({ artifact }) => artifact,
      runReviewer: async () => {
        reviewerCalls += 1;
        // If this fires, the loop didn't honour the collapse contract.
        // Return a request_revision so the test detects the leak: a
        // bypassed call would terminate on round 0 with accept, but a
        // non-bypassed call would extend to round 1.
        return {
          intent: "request_revision",
          artifact: { issues: [{ testId: "t1", problem: "leak detector" }] },
        };
      },
      reviewerCollapsed: true,
      maxReviewRounds: 3,
    });
    assert.equal(reviewerCalls, 0, "runReviewer must NOT be called when reviewerCollapsed is true");
    assert.equal(out.outcome, "accept");
    assert.equal(out.round, 0);
    assert.equal(out.roundsCompleted, 1);
  });

  await runner.test("runReviewerAuthorLoop with reviewerCollapsed:false runs runReviewer normally (multi-agent semantics preserved)", async () => {
    // Symmetric negative pin: explicit `false` must NOT short-circuit.
    // Operators who forced multi-agent semantics expect the reviewer
    // to actually run.
    let reviewerCalls = 0;
    const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
      runAuthor: async ({ artifact }) => artifact,
      runReviewer: async () => {
        reviewerCalls += 1;
        return { intent: "accept" };
      },
      reviewerCollapsed: false,
    });
    assert.equal(reviewerCalls, 1, "runReviewer must be called when reviewerCollapsed is false");
    assert.equal(out.outcome, "accept");
  });

  await runner.test("runReviewerAuthorLoop accepts reviewerCollapsed:false (operator forced multi-agent)", async () => {
    const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
      runAuthor: async ({ artifact }) => artifact,
      runReviewer: async () => ({ intent: "accept" }),
      reviewerCollapsed: false,
    });
    assert.equal(out.outcome, "accept");
  });

  await runner.test("runReviewerAuthorLoop accepts reviewerCollapsed:null (default, auto-detect)", async () => {
    // `null` is the documented default — auto-detect via the in-loop
    // `maybeWarnSingleAgentCollapse` path. Without a workspaceId the
    // helper short-circuits.
    const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
      runAuthor: async ({ artifact }) => artifact,
      runReviewer: async () => ({ intent: "accept" }),
      reviewerCollapsed: null,
    });
    assert.equal(out.outcome, "accept");
  });

  await runner.test("agentReviewerCollapsedTotal counter is registered + accepts projectId label", async () => {
    // B3 — counter carries `{projectId}` label so multi-tenant
    // operators can alert on the per-project slice from Prometheus
    // alone. Pinning the label name here so a future refactor that
    // drops it fails loudly instead of silently breaking the
    // operator's dashboard query.
    const metric = register.getSingleMetric("app_agent_reviewer_collapsed_total");
    assert.ok(metric, "counter must be registered");

    const labelName = `proj-${Date.now()}`;
    agentReviewerCollapsedTotal.inc({ projectId: labelName });
    const json = await metric.get();
    const sample = json.values.find((v) => v.labels?.projectId === labelName);
    assert.ok(sample, "counter must accept the projectId label");
    assert.equal(sample.value, 1, "exactly one increment recorded for this projectId");
  });

  runner.summary("B3 reviewer-collapse");
}

// AGENTS.md § "Use `createTestContext().createTestRunner()`" — every
// pattern-2 test file MUST surface unhandled rejections from `main()` or
// CI sees `exit code 1 with zero output` (the silent-CI-hang failure
// mode pattern 2 was designed to prevent). Mirrors the canonical
// `auto-approval-routes.test.js:178-181` shape.
main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("❌ agent-loop-collapse failed:", err);
  process.exit(1);
});
