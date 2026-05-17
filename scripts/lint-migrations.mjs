#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

export function lintMigrationPrefixes(migrationsDir) {
  const entries = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  const seen = new Map();
  const duplicates = [];
  for (const file of entries) {
    const [prefix] = file.split("_");
    if (seen.has(prefix)) duplicates.push([prefix, seen.get(prefix), file]);
    else seen.set(prefix, file);
  }
  return duplicates;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = path.resolve(process.cwd(), "backend/src/database/migrations");
  const dupes = lintMigrationPrefixes(dir);
  if (dupes.length > 0) {
    for (const [prefix, first, second] of dupes) {
      console.error(`[lint-migrations] duplicate prefix ${prefix}: ${first}, ${second}`);
    }
    process.exit(1);
  }
  console.log("[lint-migrations] OK — all migration prefixes are unique.");
}
