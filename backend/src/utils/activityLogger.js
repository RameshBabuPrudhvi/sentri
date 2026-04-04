/**
 * activityLogger.js — Shared activity logging helper
 *
 * Records user/system actions so the Work page shows a complete timeline.
 *
 * Standard naming convention — dot-separated: <resource>.<action>
 *   project.create
 *   crawl.start          crawl.complete        crawl.fail
 *   test_run.start       test_run.complete     test_run.fail
 *   test.create          test.generate         test.regenerate
 *   test.edit            test.delete
 *   test.approve         test.reject           test.restore
 *   test.bulk_approve    test.bulk_reject      test.bulk_restore
 *   settings.update
 */

import { generateActivityId } from "./idGenerator.js";
import { getDb } from "../db.js";

export function logActivity({ type, projectId, projectName, testId, testName, detail, status }) {
  const db = getDb();
  const id = generateActivityId(db);
  db.activities[id] = {
    id,
    type,
    projectId: projectId || null,
    projectName: projectName || null,
    testId: testId || null,
    testName: testName || null,
    detail: detail || null,
    status: status || "completed",
    createdAt: new Date().toISOString(),
  };
  return db.activities[id];
}
