import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lintMigrationPrefixes } from "../../scripts/lint-migrations.mjs";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "migration-lint-"));
}

{
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, "001_a.sql"), "-- a");
  fs.writeFileSync(path.join(dir, "002_b.sql"), "-- b");
  assert.deepEqual(lintMigrationPrefixes(dir), []);
}

{
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, "007_a.sql"), "-- a");
  fs.writeFileSync(path.join(dir, "007_b.sql"), "-- b");
  const dupes = lintMigrationPrefixes(dir);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0][0], "007");
}

console.log("✅ migration-runner tests passed");
