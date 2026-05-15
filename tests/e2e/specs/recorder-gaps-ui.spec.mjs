import { test, expect } from "../utils/playwright.mjs";
import { isReachable } from "../utils/environment.mjs";

/**
 * UI E2E coverage for DIF-015c Gaps 2/3/5 — Tier-3 page.route() mocks.
 *
 * Recorder backend lifecycle (Playwright launch, CDP screencast,
 * binding install, framenavigated capture) is exercised by the unit
 * tests at backend/tests/recorder*.test.js. This spec focuses on the
 * UI affordances added to RecorderModal:
 *
 *   - Gap 2: pick-by-click toggle + assertCount/assertHasClass options
 *   - Gap 3: Pause/Resume capture + Undo last step buttons
 *   - Gap 5: Device dropdown at launch + mid-session device picker
 */
test.describe("Recorder gaps UI (DIF-015c)", () => {
  test.skip(process.env.RUN_UI_E2E !== "true", "Set RUN_UI_E2E=true to run browser UI coverage.");

  let projectId;
  let email;
  const password = "Password123!";

  test.beforeAll(async ({ request, baseURL }) => {
    const ok = await isReachable(`${baseURL}/login`);
    if (!ok) return;
    email = `recorder-gaps-${Date.now()}@example.com`;
    await request.post("/api/auth/register", { data: { name: "QA", email, password } });
    await request.post("/api/auth/login", { data: { email, password } });
    const project = await request.post("/api/v1/projects", {
      data: { name: "Recorder Gaps Project", url: "https://example.com" },
    });
    if (project.ok()) projectId = (await project.json()).id;
  });

  // 1x1 transparent JPEG so the canvas paint loop has something to flip
  // past the "Waiting for browser stream..." placeholder.
  const TINY_JPEG_B64 = "/9j/4AAQSkZJRgABAQEAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL/AP//Z";

  async function mountRecorderMocks(page) {
    await page.route(/\/api\/(v1\/)?projects\/[^/]+\/record(\?.*)?$/, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: "REC-uitest-1",
          startUrl: "https://example.com",
          device: "iPhone 14",
          viewport: { width: 390, height: 844 },
        }),
      });
    });

    await page.route(/\/api\/(v1\/)?runs\/REC-uitest-1\/events(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: `event: frame\ndata: ${JSON.stringify({ data: TINY_JPEG_B64 })}\n\n`,
      });
    });

    await page.route(/\/api\/(v1\/)?projects\/[^/]+\/record\/REC-uitest-1(\?.*)?$/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: "REC-uitest-1",
          status: "recording",
          url: "https://example.com",
          startedAt: Date.now(),
          actionCount: 0,
          actions: [],
        }),
      });
    });

    await page.route(/\/api\/(v1\/)?projects\/[^/]+\/record\/REC-uitest-1\/(pause|resume|pop-last|input|probe|device|stop)(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });
  }

  async function loginAndOpenRecorder(page) {
    await page.goto("/login");
    await page.getByRole("textbox", { name: /email/i }).fill(email);
    await page.getByRole("textbox", { name: /password/i }).fill(password);
    await page.getByRole("button", { name: /login|sign in/i }).first().click();
    await page.goto(`/projects/${projectId}/test-lab`);
    await page.getByRole("button", { name: /record a test/i }).first().click();
  }

  test("Gap 5 — device dropdown lists curated DEVICE_PRESETS in the idle form", async ({ page, baseURL }) => {
    test.skip(!projectId, "API scaffolding unavailable.");
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, "Frontend not reachable.");
    await mountRecorderMocks(page);
    await loginAndOpenRecorder(page);

    const deviceSelect = page.getByLabel(/^device$/i).first();
    await expect(deviceSelect).toBeVisible();
    // Spot-check a few options. If any of these is missing, the curated
    // list has drifted from DEVICE_PRESETS in backend/src/runner/config.js.
    await expect(deviceSelect.locator("option", { hasText: "Desktop (default)" })).toHaveCount(1);
    await expect(deviceSelect.locator("option", { hasText: "iPhone 14" })).toHaveCount(1);
    await expect(deviceSelect.locator("option", { hasText: "Pixel 7" })).toHaveCount(1);
    await expect(deviceSelect.locator("option", { hasText: "Galaxy S9+" })).toHaveCount(1);
  });

  test("Gap 3 — Pause + Undo buttons appear in the recording sidebar", async ({ page, baseURL }) => {
    test.skip(!projectId, "API scaffolding unavailable.");
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, "Frontend not reachable.");
    await mountRecorderMocks(page);
    await loginAndOpenRecorder(page);
    await page.getByRole("button", { name: /launch recorder/i }).click();

    await expect(page.getByRole("button", { name: /pause capture/i })).toBeVisible();
    const undoBtn = page.getByRole("button", { name: /undo last step/i });
    await expect(undoBtn).toBeVisible();
    // Empty actions[] → Undo starts disabled
    await expect(undoBtn).toBeDisabled();

    await page.getByRole("button", { name: /pause capture/i }).click();
    await expect(page.getByRole("button", { name: /resume capture/i })).toBeVisible();
  });

  test("Gap 2 — Pick element by clicking toggle flips canvas into assert mode", async ({ page, baseURL }) => {
    test.skip(!projectId, "API scaffolding unavailable.");
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, "Frontend not reachable.");
    await mountRecorderMocks(page);
    await loginAndOpenRecorder(page);
    await page.getByRole("button", { name: /launch recorder/i }).click();

    const pickBtn = page.getByRole("button", { name: /pick element by clicking/i });
    await expect(pickBtn).toBeVisible();
    await pickBtn.click();

    // Active-state label change + ASSERT MODE badge on the canvas.
    await expect(page.getByRole("button", { name: /pick mode active/i })).toBeVisible();
    await expect(page.getByText(/assert mode — click to pick/i)).toBeVisible();
  });

  test("Gap 2 — verification picker exposes assertCount + assertHasClass options", async ({ page, baseURL }) => {
    test.skip(!projectId, "API scaffolding unavailable.");
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, "Frontend not reachable.");
    await mountRecorderMocks(page);
    await loginAndOpenRecorder(page);
    await page.getByRole("button", { name: /launch recorder/i }).click();

    // The assertion-kind dropdown is the first <select> in the
    // verification footer. Assert the two new options are present.
    const assertKindSelect = page.locator("select").filter({ hasText: /element visible/i }).first();
    await expect(assertKindSelect.locator("option", { hasText: "Element count equals" })).toHaveCount(1);
    await expect(assertKindSelect.locator("option", { hasText: "Element has class" })).toHaveCount(1);
  });

  test("Gap 5 — mid-session device change shows confirmation modal", async ({ page, baseURL }) => {
    test.skip(!projectId, "API scaffolding unavailable.");
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, "Frontend not reachable.");
    await mountRecorderMocks(page);
    await loginAndOpenRecorder(page);
    await page.getByRole("button", { name: /launch recorder/i }).click();

    // Mid-session picker carries an explicit id so it's easy to target.
    const midSelect = page.locator("#recorder-device-mid");
    await expect(midSelect).toBeVisible();
    await midSelect.selectOption("Pixel 7");

    // Confirmation modal asks the operator to acknowledge the page-state
    // reset before the rebuild fires.
    await expect(page.getByText(/switch device profile\?/i)).toBeVisible();
    await expect(page.getByText(/page will reload/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^switch device$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^cancel$/i })).toBeVisible();
  });
});
