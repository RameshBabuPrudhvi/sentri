import { runAgent } from "./agent.js";

/**
 * Sentri Phase 1 Pipeline
 *
 *   crawl_output
 *     → filter        (remove noise)
 *     → planner       (intent-driven test plans)
 *     → executor      (generate Playwright code)
 *     → assertion_enhancer (upgrade assertions)
 *     → auditor       (post-run analysis, called separately)
 *
 * Each stage passes structured JSON to the next.
 */

/**
 * Run the full pre-execution pipeline for a crawled page.
 *
 * @param {object} crawlOutput - Raw output from the Playwright crawler
 * @param {string} crawlOutput.url - The page URL
 * @param {Array}  crawlOutput.elements - Raw DOM elements snapshot
 * @returns {Promise<PipelineResult>}
 */
export async function runPipeline(crawlOutput) {
  const { url, elements } = crawlOutput;
  console.log(
    `\n🚀 [Pipeline] Starting for ${url} with ${elements.length} raw elements`
  );

  // ── Stage 1: Filter ─────────────────────────────────────────────
  console.log("🧹 [Pipeline] Stage 1: Filter");

  const filterInput = {
    page_url: url,
    raw_elements: elements,
    instruction: `
Filter the following crawled elements.

RULES:
- Keep elements that represent real user interactions
- Prefer inputs, buttons, links, forms
- Remove decorative or repeated UI elements
- Do NOT remove everything — always keep at least a few meaningful elements
`,
  };

  let filterOutput = await runAgent("filter", filterInput);

  console.log("   Filter raw output:", JSON.stringify(filterOutput, null, 2));

  // ✅ Fallback if filter removes everything
  if (
    !filterOutput.filtered_elements ||
    filterOutput.filtered_elements.length === 0
  ) {
    console.log(
      "   ⚠ Filter removed everything — using fallback (all elements)"
    );

    filterOutput.filtered_elements = elements.map((el, i) => ({
      id: `el-${i}`,
      type: el.tag,
      role: el.ariaRole || el.type || el.tag,
      selector: el.selector,
      page: url,
      user_intent:
        el.text || el.ariaLabel || el.placeholder || "interactive element",
    }));
  }

  console.log(
    `   ✓ ${filterOutput.filtered_elements.length} elements kept`
  );

  // ── Stage 2: Planner ─────────────────────────────────────────────
  console.log("🧩 [Pipeline] Stage 2: Planner");

  const plannerInput = {
    page_url: url,
    filtered_elements: filterOutput.filtered_elements,
    instruction: `
Generate Playwright test plans from these elements.

STRICT RULES:
- ALWAYS generate at least 1–3 test plans
- Even for simple pages, create basic interaction tests
- Include:
  - typing into inputs
  - clicking buttons
  - navigation
- Each plan must include:
  - id
  - goal
  - priority (low/medium/high)
  - steps (array)

DO NOT return empty output.
`,
  };

  let plannerOutput = await runAgent("planner", plannerInput);

  console.log(
    "   Planner raw output:",
    JSON.stringify(plannerOutput, null, 2)
  );

  let plans = plannerOutput.test_plans || [];

  // ✅ Planner fallback (CRITICAL FIX)
  if (plans.length === 0) {
    console.log(
      "   ⚠ Planner returned 0 plans — generating fallback plans"
    );

    plans = filterOutput.filtered_elements.slice(0, 3).map((el, i) => ({
      id: `fallback-${i}`,
      goal: `Interact with ${el.user_intent}`,
      priority: "low",
      steps: [
        { action: "navigate", url },
        { action: "interact", selector: el.selector },
      ],
    }));
  }

  console.log(`   ✓ ${plans.length} test plans created`);

  // ── Stage 3 + 4: Executor → Assertion Enhancer ───────────────────
  const enhancedTests = [];

  for (const plan of plans) {
    try {
      console.log(
        `\n⚡ [Pipeline] Stage 3: Executor for plan "${plan.goal}"`
      );

      const executorInput = {
        plan,
        instruction: `
Convert this test plan into a complete Playwright TypeScript test.

RULES:
- Use stable selectors
- Use test.step()
- Include navigation
- Make it runnable
`,
      };

      const executorOutput = await runAgent("executor", executorInput);

      console.log(`   ✓ Generated: ${executorOutput?.test_file}`);

      console.log(
        `🎯 [Pipeline] Stage 4: Assertion Enhancer for "${plan.goal}"`
      );

      const enhancerInput = {
        plan_id: plan.id,
        goal: plan.goal,
        original_test: executorOutput.test_code,
        instruction: `
Enhance this Playwright test with strong assertions.

RULES:
- Every action must have at least one assertion
- Add visibility checks, text checks, navigation checks
- Improve reliability
`,
      };

      const enhancedOutput = await runAgent(
        "assertion_enhancer",
        enhancerInput
      );

      console.log(
        `   ✓ Assertions: ${enhancedOutput.original_assertion_count} → ${enhancedOutput.enhanced_assertion_count}`
      );

      enhancedTests.push({
        plan,
        test_file: enhancedOutput.test_file,
        test_code: enhancedOutput.test_code,
        enhancements: enhancedOutput.enhancements_made,
        assertion_count: enhancedOutput.enhanced_assertion_count,
      });
    } catch (err) {
      console.error(
        `❌ Error processing plan "${plan.goal}":`,
        err.stack
      );
    }
  }

  console.log(
    `\n✅ [Pipeline] Complete for ${url}: ${enhancedTests.length} high-quality tests generated`
  );

  return {
    url,
    skipped: false,
    stats: {
      raw_elements: elements.length,
      filtered_elements: filterOutput.filtered_elements.length,
      plans_created: plans.length,
      tests_generated: enhancedTests.length,
    },
    tests: enhancedTests,
  };
}

/**
 * Post-execution: Run the Auditor on failed tests.
 *
 * @param {object} executionResult - Result from testRunner with logs/errors
 * @returns {Promise<AuditReport>}
 */
export async function auditFailedTest(executionResult) {
  console.log(`\n🧪 [Auditor] Analyzing failure: ${executionResult.test_id}`);
  const auditInput = {
    test_id: executionResult.test_id,
    test_code: executionResult.test_code,
    execution_logs: executionResult.logs,
    error_message: executionResult.error,
    instruction:
      "Analyze this test failure. Classify it, find root cause, and prescribe a fix.",
  };
  return runAgent("auditor", auditInput);
}

/**
 * Run the full pipeline across multiple crawled pages.
 * Deduplicates equivalent test plans across pages.
 *
 * @param {Array<object>} crawlResults - Array of per-page crawl outputs
 * @returns {Promise<Array<PipelineResult>>}
 */
export async function runPipelineForCrawl(crawlResults) {
  const results = [];
  for (const pageResult of crawlResults) {
    try {
      const pipelineResult = await runPipeline(pageResult);
      results.push(pipelineResult);
    } catch (err) {
      console.error(`[Pipeline] Error for ${pageResult.url}:`, err.message);
      results.push({ url: pageResult.url, error: err.message });
    }
  }
  return results;
}