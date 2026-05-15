import { test, expect } from "../utils/playwright.mjs";

test("run detail renders root cause summary", async ({ page }) => {
  const runId = "RUN-ROOT-1";
  await page.route(`**/api/v1/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        run: {
          id: runId,
          projectId: "PRJ-1",
          type: "test_run",
          status: "completed",
          total: 2,
          results: [],
          rootCauses: [
            { fingerprint: "a", errorPattern: "auth down", size: 2, affectedTestIds: ["TC-1", "TC-2"], sharedUrl: "https://api.example.com/auth", sharedSelector: "#login" },
          ],
        },
      }),
    });
  });
  await page.goto(`/runs/${runId}`);
  await expect(page.getByText("Root Cause Summary")).toBeVisible();
});
