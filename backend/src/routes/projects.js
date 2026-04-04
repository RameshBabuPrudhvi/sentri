/**
 * projects.js — Project CRUD routes
 *
 * Mounted at /api/projects in index.js
 */

import { Router } from "express";
import { getDb } from "../db.js";
import { generateProjectId } from "../utils/idGenerator.js";
import { logActivity } from "../utils/activityLogger.js";

const router = Router();

router.post("/", (req, res) => {
  const db = getDb();
  const { name, url, credentials } = req.body;
  if (!name || !url) return res.status(400).json({ error: "name and url required" });

  const id = generateProjectId(db);
  const project = {
    id,
    name,
    url,
    credentials: credentials || null,
    createdAt: new Date().toISOString(),
    status: "idle",
  };
  db.projects[id] = project;

  logActivity({
    type: "project.create", projectId: id, projectName: name,
    detail: `Project created — "${name}" (${url})`,
  });

  res.json(project);
});

router.get("/", (req, res) => {
  const db = getDb();
  res.json(Object.values(db.projects));
});

router.get("/:id", (req, res) => {
  const db = getDb();
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "not found" });
  res.json(project);
});

router.delete("/:id", (req, res) => {
  const db = getDb();
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "not found" });

  // Refuse deletion while async operations are in progress to prevent orphaned data
  const activeRuns = Object.values(db.runs).filter(
    r => r.projectId === req.params.id && r.status === "running"
  );
  if (activeRuns.length > 0) {
    return res.status(409).json({
      error: "Cannot delete project while operations are running. Wait for active crawls or test runs to complete.",
    });
  }

  // Delete associated tests
  const testIds = Object.keys(db.tests).filter(tid => db.tests[tid].projectId === req.params.id);
  testIds.forEach(tid => delete db.tests[tid]);

  // Delete associated runs
  const runIds = Object.keys(db.runs).filter(rid => db.runs[rid].projectId === req.params.id);
  runIds.forEach(rid => delete db.runs[rid]);

  // Delete associated activities
  const activityIds = Object.keys(db.activities).filter(aid => db.activities[aid].projectId === req.params.id);
  activityIds.forEach(aid => delete db.activities[aid]);

  // Delete the project itself
  delete db.projects[req.params.id];

  logActivity({
    type: "project.delete", projectId: req.params.id, projectName: project.name,
    detail: `Project deleted — "${project.name}" (${testIds.length} tests, ${runIds.length} runs removed)`,
  });

  res.json({ ok: true, deletedTests: testIds.length, deletedRuns: runIds.length });
});

export default router;
