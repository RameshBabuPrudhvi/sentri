import crypto from "crypto";
import os from "os";
import fs from "fs";
import path from "path";
import { formatLogLine } from "./logFormatter.js";

const TELEMETRY_ENABLED = process.env.SENTRI_TELEMETRY !== "0" && process.env.DO_NOT_TRACK !== "1";
const POSTHOG_KEY = process.env.POSTHOG_API_KEY || "";
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
const CACHE_DIR = path.join(process.cwd(), "data");
const CACHE_FILE = path.join(CACHE_DIR, "telemetry-cache.json");

// Events that are sent at most once per install lifetime (e.g. first run).
// All other events are sent every time — daily-dedup would under-count usage.
const ONCE_PER_INSTALL = new Set(["install.first_run"]);

let PostHog = null;
let posthogLoadAttempted = false;
let client = null;

// In-memory mirror of the persisted "once per install" cache. Avoids a sync
// disk read on every event in the request hot path. The file is only touched
// on first event of a given lifetime key.
let cacheMem = null;

async function loadPostHog() {
  if (posthogLoadAttempted) return;
  posthogLoadAttempted = true;
  try { ({ PostHog } = await import("posthog-node")); } catch { /* optional dep */ }
}

function anonId() {
  const raw = `${os.hostname()}|${process.cwd()}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function loadCache() {
  if (cacheMem) return cacheMem;
  try { cacheMem = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); }
  catch { cacheMem = {}; }
  return cacheMem;
}

function saveCacheAsync(cache) {
  fs.promises.mkdir(CACHE_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(CACHE_FILE, JSON.stringify(cache)))
    .catch(() => { /* best-effort */ });
}

/**
 * Lifetime dedup for events in ONCE_PER_INSTALL. Returns true if the event
 * should be sent. All other events are always sent.
 */
function shouldSend(eventName) {
  if (!ONCE_PER_INSTALL.has(eventName)) return true;
  const cache = loadCache();
  // Prune any legacy daily keys (`YYYY-MM-DD:event`) left over from the old
  // dedup scheme to keep the file bounded.
  let pruned = false;
  for (const k of Object.keys(cache)) {
    if (/^\d{4}-\d{2}-\d{2}:/.test(k)) { delete cache[k]; pruned = true; }
  }
  if (cache[eventName]) {
    if (pruned) saveCacheAsync(cache);
    return false;
  }
  cache[eventName] = true;
  saveCacheAsync(cache);
  return true;
}

function sanitizeProps(props = {}) {
  const next = { ...props };
  if (next.url) {
    try { next.domain = new URL(next.url).hostname; } catch {}
    delete next.url;
  }
  return next;
}

export function trackTelemetry(eventName, props = {}) {
  if (!TELEMETRY_ENABLED || !POSTHOG_KEY) return;
  if (!shouldSend(eventName)) return;
  // Fire-and-forget: never block or throw on the request hot path.
  (async () => {
    try {
      await loadPostHog();
      if (!PostHog) return;
      if (!client) client = new PostHog(POSTHOG_KEY, { host: POSTHOG_HOST, flushAt: 1, flushInterval: 0 });
      // posthog-node v4 `capture()` is synchronous fire-and-forget (returns void).
      client.capture({ distinctId: anonId(), event: eventName, properties: sanitizeProps(props) });
    } catch {
      console.warn(formatLogLine("warn", null, `[telemetry] failed to capture ${eventName}`));
    }
  })();
}
