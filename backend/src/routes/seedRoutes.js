/**
 * @module routes/seedRoutes
 * @description Test-only seed routes for integration tests.
 *
 * NEVER import this file from index.js or any production code path.
 * Mount it only in test setup files against a test-only Express instance.
 *
 * @example
 * // In your test setup (e.g. tests/setup.js):
 * import { app } from "../src/middleware/appSetup.js";
 * import seedRouter from "../src/routes/seedRoutes.js";
 * app.use("/api", seedRouter);
 */

import { Router } from "express";
import * as runRepo from "../database/repositories/runRepo.js";
import { requireAuth } from "./auth.js";

const router = Router();

router.patch("/_seed/runs/:id", requireAuth, (req, res) => {
  const runData = { ...req.body, id: req.params.id };
  const existing = runRepo.getById(req.params.id);
  if (existing) {
    runRepo.save(runData);
  } else {
    runRepo.create(runData);
  }
  res.json({ ok: true, id: req.params.id });
});

export default router;
