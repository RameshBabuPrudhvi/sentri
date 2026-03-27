import { chromium } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_PAGES = 20;
const MAX_DEPTH = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(run, msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  run.logs.push(entry);
  console.log(entry);
}

function sameOrigin(base, href) {
  try {
    return new URL(href).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return null;
  }
}

// ─── DOM snapshot ─────────────────────────────────────────────────────────────

async function takeSnapshot(page) {
  return page.evaluate(() => {
    const interactable = [];
    const elements = document.querySelectorAll(
      "a, button, input, select, textarea, [role='button'], [role='link'], form"
    );
    elements.forEach((el) => {
      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || "")
        .trim()
        .slice(0, 80);
      const type = el.getAttribute("type") || "";
      const href = el.getAttribute("href") || "";
      const id = el.id || "";
      const name = el.getAttribute("name") || "";
      interactable.push({ tag, text, type, href, id, name });
    });
    return {
      title: document.title,
      url: location.href,
      elements: interactable.slice(0, 60),
      h1: Array.from(document.querySelectorAll("h1")).map((h) => h.innerText).join(" | "),
      forms: Array.from(document.querySelectorAll("form")).length,
    };
  });
}

// ─── AI test generation ───────────────────────────────────────────────────────

async function generateTestsForPage(snapshot, projectUrl) {
  const prompt = `You are an expert QA engineer. Given this page snapshot from a web application, generate 2-4 specific, actionable Playwright test cases.

Page snapshot:
- URL: ${snapshot.url}
- Title: ${snapshot.title}
- H1: ${snapshot.h1}
- Forms on page: ${snapshot.forms}
- Interactive elements: ${JSON.stringify(snapshot.elements, null, 2)}

Generate test cases as a JSON array. Each test case must have:
- "name": short descriptive test name
- "description": what this test validates
- "priority": "high" | "medium" | "low"
- "type": "navigation" | "form" | "visibility" | "interaction"
- "steps": array of plain-English steps
- "playwrightCode": complete runnable Playwright test code using page object, targeting this URL: ${snapshot.url}

Focus on: page loads correctly, key elements visible, forms functional, navigation works.
Return ONLY valid JSON array, no markdown fences.`;

  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = msg.content[0].text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ─── Main crawler ─────────────────────────────────────────────────────────────

export async function crawlAndGenerateTests(project, run, db) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (compatible; AutonomousQA/1.0)",
  });

  const visited = new Set();
  const queue = [{ url: project.url, depth: 0 }];
  const pageSnapshots = [];

  log(run, `🕷️  Starting crawl of ${project.url}`);

  // Handle login if credentials provided
  if (project.credentials) {
    const loginPage = await context.newPage();
    try {
      await loginPage.goto(project.url, { timeout: 15000 });
      const { usernameSelector, username, passwordSelector, password, submitSelector } =
        project.credentials;
      if (usernameSelector && username) {
        await loginPage.fill(usernameSelector, username);
        await loginPage.fill(passwordSelector, password);
        await loginPage.click(submitSelector);
        await loginPage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        log(run, `🔑 Logged in as ${username}`);
      }
    } catch (e) {
      log(run, `⚠️  Login attempt failed: ${e.message}`);
    }
    await loginPage.close();
  }

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const { url, depth } = queue.shift();
    if (visited.has(url) || depth > MAX_DEPTH) continue;
    visited.add(url);

    const page = await context.newPage();
    try {
      log(run, `📄 Visiting (depth ${depth}): ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(1000);

      const snapshot = await takeSnapshot(page);
      pageSnapshots.push(snapshot);
      run.pagesFound = pageSnapshots.length;

      // Collect links
      if (depth < MAX_DEPTH) {
        const links = await page.$$eval("a[href]", (els) => els.map((e) => e.href));
        for (const href of links) {
          const normalized = normalizeUrl(href, url);
          if (normalized && sameOrigin(project.url, normalized) && !visited.has(normalized)) {
            queue.push({ url: normalized, depth: depth + 1 });
          }
        }
      }
    } catch (err) {
      log(run, `⚠️  Failed to visit ${url}: ${err.message}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  log(run, `✅ Crawl complete. Found ${pageSnapshots.length} pages. Generating tests with AI...`);

  // Generate tests per page
  for (const snapshot of pageSnapshots) {
    log(run, `🤖 Generating tests for: ${snapshot.url}`);
    try {
      const generatedTests = await generateTestsForPage(snapshot, project.url);
      for (const t of generatedTests) {
        const testId = uuidv4();
        db.tests[testId] = {
          id: testId,
          projectId: project.id,
          sourceUrl: snapshot.url,
          pageTitle: snapshot.title,
          createdAt: new Date().toISOString(),
          lastResult: null,
          ...t,
        };
        run.tests.push(testId);
      }
      log(run, `  → Generated ${generatedTests.length} tests`);
    } catch (err) {
      log(run, `  ⚠️  AI generation failed for ${snapshot.url}: ${err.message}`);
    }
  }

  run.status = "completed";
  run.finishedAt = new Date().toISOString();
  log(run, `🎉 Done! Generated ${run.tests.length} total tests.`);
}
