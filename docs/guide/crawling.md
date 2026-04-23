# Crawling

Sentri launches a real Chromium browser and explores your app automatically.

## How It Works

1. Starts at the project URL
2. Discovers links, forms, buttons, and interactive elements
3. Follows links up to 3 levels deep
4. Captures DOM snapshots for each page (forms, semantic sections, heading hierarchy)
5. A **SmartCrawlQueue** fingerprints page structure to skip near-duplicate pages

## Authenticated Crawling

If your app requires sign-in, configure credentials when creating the project. Sentri authenticates before crawling.

## Site Graph

During crawling, a **D3 force-directed Site Graph** shows discovered pages in real time with colour-coded status:

- 🟢 Crawled successfully
- 🔵 Has generated tests
- 🔴 Error during crawl
- ⚪ Queued / not yet visited

## Stopping a Crawl

Click **Stop** at any time. The abort signal propagates through the entire pipeline — browser operations and AI calls halt immediately.

## Unreachable Targets

If the project URL cannot be resolved (DNS failure, `ERR_NAME_NOT_RESOLVED`), refuses connections, returns TLS errors, or times out, the crawl is classified as **failed** with a category-specific reason rather than silently finishing as `Completed (empty)`:

- **DNS** — "target host could not be resolved — check typos / verify hostname / verify VPN"
- **Network / TLS** — "target URL is unreachable — `<raw Playwright error>`"
- **Timeout** — surfaced via the same classification path

Open the run's Activity Log for the full Playwright error message. If you need VPN access to reach an internal host, ensure it's connected before retrying the crawl.

## Crawl Results

After crawling, Sentri runs the AI generation pipeline on each discovered page. Generated tests land in the **Draft** queue for review.
