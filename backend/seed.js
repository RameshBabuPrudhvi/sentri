#!/usr/bin/env node
/**
 * seed.js — Inject realistic demo data into the Sentri in-memory DB via REST API.
 *
 * Run AFTER the backend is started:
 *   node seed.js
 *
 * Or with a custom port:
 *   BASE_URL=http://localhost:4000 node seed.js
 *
 * What this creates:
 *   1 project  — "Acme Shop" (e-commerce demo)
 *   1 crawl run (completed, 4 pages found)
 *   3 tests    — approved login test, approved checkout test, rejected draft test
 *   1 test run (completed, 2 passed / 1 failed)
 *   activities — automatically logged by the API for every action above
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// ── helpers ──────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

const get  = (path)       => api("GET",   path);
const post = (path, body) => api("POST",  path, body);
const patch = (path, body) => api("PATCH", path, body);

// ── direct DB injection via a tiny in-process shim ───────────────────────────
// We cannot write to the in-memory DB from outside the process, so we inject
// the crawl run and test run results by calling the REST API and then patching
// them into a realistic "completed" state via the /api/runs/:id endpoint.
// (The API has no PATCH /runs endpoint, so we expose what we need via seed-only
//  POST /api/seed that we add temporarily — OR we just build the state through
//  normal API calls and manually simulate the run result shape.)
//
// Strategy:
//   • Create project, tests via API (gives us real IDs)
//   • Approve tests via API
//   • Inject completed crawl run and test run shapes directly by calling
//     a tiny seed endpoint we add to index.js at start-up.
//   • If seed endpoint is not available, we fall back to writing a seed.json
//     file that can be imported at server start (see README note at bottom).

async function injectRunDirectly(runId, patch) {
  // Try the /api/seed endpoint first (added by seed-middleware below)
  try {
    return await api("PATCH", `/api/_seed/runs/${runId}`, patch);
  } catch {
    console.warn("  ⚠  /api/_seed endpoint not found — run result will show as 'running'.");
    console.warn("     Start the server with:  SEED=1 node src/index.js");
    console.warn("     Or apply the seed middleware patch described at the bottom of this file.");
  }
}

// ── seed data ─────────────────────────────────────────────────────────────────

const NOW = new Date();
const mins = (n) => new Date(NOW.getTime() - n * 60_000).toISOString();
const secs = (n) => new Date(NOW.getTime() - n * 1_000).toISOString();

async function seed() {
  console.log(`\n🌱  Seeding Sentri demo data → ${BASE_URL}\n`);

  // ── 1. Project ─────────────────────────────────────────────────────────────
  console.log("📁  Creating project...");
  const project = await post("/api/projects", {
    name: "Acme Shop",
    url:  "https://demo.acmeshop.io",
  });
  const pid = project.id;
  console.log(`    ✓ Project "${project.name}" — ${pid}`);

  // ── 2. Tests ───────────────────────────────────────────────────────────────
  console.log("\n🧪  Creating tests...");

  const loginTest = await post(`/api/projects/${pid}/tests`, {
    name:        "Login with valid credentials",
    description: "Verifies that a registered user can log in and land on the dashboard",
    priority:    "high",
    type:        "ai-generated",
    steps: [
      "Navigate to https://demo.acmeshop.io/login",
      "Fill in email field with 'user@acme.io'",
      "Fill in password field with 'correct-password'",
      "Click the 'Sign In' button",
      "Assert URL contains '/dashboard'",
      "Assert heading 'Welcome back' is visible",
    ],
    playwrightCode: `test('Login with valid credentials', async ({ page }) => {
  await page.goto('https://demo.acmeshop.io/login');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Email').fill('user@acme.io');
  await page.getByLabel('Password').fill('correct-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveURL(/\\/dashboard/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByTestId('user-menu')).toBeVisible();
});`,
  });
  console.log(`    ✓ Test "${loginTest.name}" — ${loginTest.id}`);

  const checkoutTest = await post(`/api/projects/${pid}/tests`, {
    name:        "Add item to cart and proceed to checkout",
    description: "Verifies the full add-to-cart → checkout initiation flow",
    priority:    "high",
    type:        "ai-generated",
    steps: [
      "Navigate to https://demo.acmeshop.io/products",
      "Click on 'Running Shoes Pro' product card",
      "Select size 'M' from the size selector",
      "Click 'Add to Cart' button",
      "Assert cart badge shows '1'",
      "Click the cart icon",
      "Click 'Proceed to Checkout'",
      "Assert URL contains '/checkout'",
    ],
    playwrightCode: `test('Add item to cart and proceed to checkout', async ({ page }) => {
  await page.goto('https://demo.acmeshop.io/products');
  await page.waitForLoadState('networkidle');
  await page.getByText('Running Shoes Pro').click();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'M' }).click();
  await page.getByRole('button', { name: 'Add to Cart' }).click();
  await expect(page.getByTestId('cart-badge')).toHaveText('1');
  await page.getByTestId('cart-icon').click();
  await page.getByRole('button', { name: 'Proceed to Checkout' }).click();
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveURL(/\\/checkout/);
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
});`,
  });
  console.log(`    ✓ Test "${checkoutTest.name}" — ${checkoutTest.id}`);

  const draftTest = await post(`/api/projects/${pid}/tests`, {
    name:        "Password reset flow",
    description: "Tests the forgot-password → email → reset link flow",
    priority:    "medium",
    type:        "ai-generated",
    steps: [
      "Navigate to https://demo.acmeshop.io/login",
      "Click 'Forgot password?' link",
      "Fill in email field with 'user@acme.io'",
      "Click 'Send Reset Link'",
      "Assert success message is visible",
    ],
    playwrightCode: `test('Password reset flow', async ({ page }) => {
  await page.goto('https://demo.acmeshop.io/login');
  await page.getByText('Forgot password?').click();
  await page.getByLabel('Email').fill('user@acme.io');
  await page.getByRole('button', { name: 'Send Reset Link' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();
});`,
  });
  console.log(`    ✓ Test "${draftTest.name}" — ${draftTest.id} (draft)`);

  // ── 3. Review tests ────────────────────────────────────────────────────────
  console.log("\n✅  Approving / rejecting tests...");
  await patch(`/api/projects/${pid}/tests/${loginTest.id}/approve`);
  console.log(`    ✓ Approved: "${loginTest.name}"`);
  await patch(`/api/projects/${pid}/tests/${checkoutTest.id}/approve`);
  console.log(`    ✓ Approved: "${checkoutTest.name}"`);
  await patch(`/api/projects/${pid}/tests/${draftTest.id}/reject`);
  console.log(`    ✓ Rejected: "${draftTest.name}" (intentional — shows rejection flow)`);

  // ── 4. Inject completed crawl run ──────────────────────────────────────────
  console.log("\n🕷   Injecting completed crawl run...");
  const crawlRunId  = await injectCompletedCrawlRun(pid, project.name, project.url);
  console.log(`    ✓ Crawl run — ${crawlRunId || "(see warning above)"}`);

  // ── 5. Inject completed test run ───────────────────────────────────────────
  console.log("\n▶️   Injecting completed test run...");
  const testRunId = await injectCompletedTestRun(
    pid, project.name,
    loginTest, checkoutTest
  );
  console.log(`    ✓ Test run — ${testRunId || "(see warning above)"}`);

  // ── Done ───────────────────────────────────────────────────────────────────
  console.log(`
✅  Seed complete!

   Project ID : ${pid}
   Tests      : ${loginTest.id} (approved)
                ${checkoutTest.id} (approved)
                ${draftTest.id} (rejected)
   Crawl run  : ${crawlRunId || "n/a"}
   Test run   : ${testRunId || "n/a"}

   Open the UI → you should see all pages populated with realistic data.
`);
}

// ── crawl run payload ─────────────────────────────────────────────────────────

async function injectCompletedCrawlRun(projectId, projectName, projectUrl) {
  const runData = {
    id:          crypto.randomUUID(),
    projectId,
    type:        "crawl",
    status:      "completed",
    startedAt:   mins(8),
    finishedAt:  mins(6),
    pagesFound:  4,
    logs: [
      `[${mins(8)}] 🕷  Crawl started for ${projectUrl}`,
      `[${mins(8)}] Navigating to ${projectUrl}`,
      `[${mins(7)}] ✓ Found page: /login (AUTH — confidence 95)`,
      `[${mins(7)}] ✓ Found page: /products (CONTENT — confidence 72)`,
      `[${mins(7)}] ✓ Found page: /cart (CHECKOUT — confidence 88)`,
      `[${mins(7)}] ✓ Found page: /dashboard (NAVIGATION — confidence 81)`,
      `[${mins(6)}] 🧠 Classifying pages & generating tests...`,
      `[${mins(6)}] ✓ Generated 3 tests from 4 pages`,
      `[${mins(6)}] ✅ Crawl complete`,
    ],
    tests: [],
    pages: [
      { url: `${projectUrl}/login`,     title: "Sign In — Acme Shop",      intent: "AUTH",       confidence: 95 },
      { url: `${projectUrl}/products`,  title: "Products — Acme Shop",     intent: "CONTENT",    confidence: 72 },
      { url: `${projectUrl}/cart`,      title: "Your Cart — Acme Shop",    intent: "CHECKOUT",   confidence: 88 },
      { url: `${projectUrl}/dashboard`, title: "Dashboard — Acme Shop",    intent: "NAVIGATION", confidence: 81 },
    ],
  };
  return injectRunDirectly(runData.id, runData).then(() => runData.id);
}

// ── test run payload ──────────────────────────────────────────────────────────

async function injectCompletedTestRun(projectId, projectName, loginTest, checkoutTest) {
  const runId = crypto.randomUUID();

  const passedResult = {
    testId:        loginTest.id,
    testName:      loginTest.name,
    steps:         loginTest.steps,
    status:        "passed",
    durationMs:    3241,
    error:         null,
    screenshot:    null,
    screenshotPath: null,
    videoPath:     null,
    runTimestamp:  new Date(mins(2)).getTime(),
    network: [
      { id: crypto.randomUUID(), method: "GET",  url: "https://demo.acmeshop.io/login",     status: 200, size: 24680, duration: 312  },
      { id: crypto.randomUUID(), method: "POST", url: "https://demo.acmeshop.io/api/auth",  status: 200, size: 512,   duration: 187  },
      { id: crypto.randomUUID(), method: "GET",  url: "https://demo.acmeshop.io/dashboard", status: 200, size: 31200, duration: 298  },
    ],
    consoleLogs: [
      { time: secs(125), level: "log",  text: "Auth token stored" },
      { time: secs(124), level: "log",  text: "User session established" },
    ],
    domSnapshot: null,
  };

  const failedResult = {
    testId:        checkoutTest.id,
    testName:      checkoutTest.name,
    steps:         checkoutTest.steps,
    status:        "failed",
    durationMs:    5820,
    error:         "Timeout 5000ms exceeded waiting for element: getByRole('button', { name: 'M' })\n  at page.getByRole → waitForSelector\n  Expected element to be visible but was not found after 5000ms.",
    screenshot:    null,
    screenshotPath: null,
    videoPath:     null,
    runTimestamp:  new Date(mins(1)).getTime(),
    network: [
      { id: crypto.randomUUID(), method: "GET",  url: "https://demo.acmeshop.io/products",             status: 200, size: 48200, duration: 421  },
      { id: crypto.randomUUID(), method: "GET",  url: "https://demo.acmeshop.io/products/shoes-pro",   status: 200, size: 28100, duration: 355  },
      { id: crypto.randomUUID(), method: "GET",  url: "https://demo.acmeshop.io/api/products/42",      status: 200, size: 1240,  duration: 98   },
    ],
    consoleLogs: [
      { time: secs(65), level: "warning", text: "Slow network response detected (>400ms)" },
      { time: secs(60), level: "error",   text: "Size selector not rendered — possible lazy-load race condition" },
    ],
    domSnapshot: null,
  };

  const runData = {
    id:         runId,
    projectId,
    type:       "test_run",
    status:     "completed",
    startedAt:  mins(3),
    finishedAt: mins(1),
    passed:     1,
    failed:     1,
    total:      2,
    results:    [passedResult, failedResult],
    logs: [
      `[${mins(3)}] 🚀 Test run started — 2 tests`,
      `[${mins(3)}] ▶  Running: "${loginTest.name}"`,
      `[${mins(2)}] ✅ PASSED "${loginTest.name}" (3241ms)`,
      `[${mins(2)}] ▶  Running: "${checkoutTest.name}"`,
      `[${mins(1)}] ❌ FAILED "${checkoutTest.name}" (5820ms)`,
      `[${mins(1)}] Error: Timeout 5000ms exceeded waiting for element: getByRole('button', { name: 'M' })`,
      `[${mins(1)}] ✅ Test run complete — 1 passed, 1 failed`,
    ],
    testQueue: [
      { id: loginTest.id,    name: loginTest.name,    steps: loginTest.steps    },
      { id: checkoutTest.id, name: checkoutTest.name, steps: checkoutTest.steps },
    ],
  };

  return injectRunDirectly(runId, runData).then(() => runId);
}

// ── run ───────────────────────────────────────────────────────────────────────
seed().catch((err) => {
  console.error("\n❌  Seed failed:", err.message);
  process.exit(1);
});

/*
───────────────────────────────────────────────────────────────────────────────
SETUP: Add the seed middleware to backend/src/index.js
───────────────────────────────────────────────────────────────────────────────

The seed script needs to write completed run objects directly into the in-memory
DB. Add this block ONCE anywhere after `const db = getDb();` in index.js:

  // ── Seed helper (dev only) ────────────────────────────────────────────────
  if (process.env.NODE_ENV !== "production") {
    app.patch("/api/_seed/runs/:id", (req, res) => {
      db.runs[req.params.id] = { ...req.body, id: req.params.id };
      res.json({ ok: true });
    });
  }

Then restart the backend and run:  node seed.js
───────────────────────────────────────────────────────────────────────────────
*/
