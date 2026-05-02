#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const outDir = path.join(backendRoot, "public", "trace-viewer");

function resolveViewerDir() {
  const candidates = [
    "playwright-core/lib/vite/traceViewer/index.html",
    "@playwright/test/lib/trace/viewer/index.html",
  ];
  for (const rel of candidates) {
    try {
      const entry = require.resolve(rel);
      return path.dirname(entry);
    } catch {}
  }
  return null;
}

const sourceDir = resolveViewerDir();
if (!sourceDir) {
  console.warn("[trace-viewer] warning: Could not resolve Playwright trace viewer bundle. /trace-viewer will 404 until dependencies provide it.");
  process.exit(0);
}

try {
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(sourceDir, outDir, { recursive: true, force: true });
  console.log(`[trace-viewer] copied bundle from ${sourceDir} to ${outDir}`);
} catch (err) {
  console.warn(`[trace-viewer] warning: Failed to copy bundle: ${err?.message || err}`);
  process.exit(0);
}
