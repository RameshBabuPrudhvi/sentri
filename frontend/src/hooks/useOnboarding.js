/**
 * @module hooks/useOnboarding
 * @description Manages onboarding tour state: step progression, completion
 * persistence, skip/dismiss logic, and **contextual auto-advance**.
 *
 * Tour is shown when ALL of these are true:
 *   1. User has never completed or dismissed the tour (localStorage flag)
 *   2. No AI provider is configured yet (config.hasProvider === false)
 *   3. No projects exist yet (totalProjects === 0)
 *
 * Auto-advance: pages dispatch `sentri:tour` CustomEvents when the user
 * completes a key action (saves an API key, creates a project). The hook
 * listens for these and jumps to the next relevant step automatically.
 *
 * @example
 * const tour = useOnboarding();
 * if (tour.active) renderTooltipAt(tour.currentStep);
 *
 * // From any page — fire-and-forget, no prop drilling:
 * emitTourEvent("provider-saved");
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api.js";

const STORAGE_KEY = "app_onboarding_completed";
const DISMISSED_KEY = "app_onboarding_dismissed";
const FORCE_KEY = "app_onboarding_force";
const TOUR_EVENT = "app:tour";

// ── Public helper: dispatch a tour event from any component ─────────────────
/**
 * Notify the onboarding tour that the user completed an action.
 * Safe to call even when the tour is inactive — it's a no-op.
 *
 * @param {"provider-saved"|"project-created"} action
 */
export function emitTourEvent(action) {
  window.dispatchEvent(new CustomEvent(TOUR_EVENT, { detail: { action } }));
}

/**
 * ONB-001 (audit) — Ordered "First Run" wizard steps. The legacy `TOUR_STEPS`
 * shape (target + placement, anchored to `data-tour` attrs on existing pages)
 * was the audit's named anti-pattern — a passive tooltip walkthrough that
 * showed users where elements were but did not help them accomplish their
 * first valuable action. A user who completed the old tour still had an
 * empty workspace and no clear next step.
 *
 * The new wizard is **active**: each step performs a real action against the
 * backend (save provider → create project → kick off crawl → review tests →
 * approve & run), and the wizard's deliverable is a real project with real
 * generated tests. Steps no longer carry `target` / `placement` / `route` —
 * the wizard renders as a centred modal via `<ModalShell>` so it works
 * regardless of which route the user is on.
 *
 * The `advanceOn` mechanism is kept so that operators who close the wizard
 * and complete the matching action manually (e.g. saving a provider via
 * `/settings/ai_providers`) still progress the wizard cleanly on next open.
 *
 * @typedef {Object} TourStep
 * @property {string} id          - Stable identifier (used by JSX switch + tests).
 * @property {string} title       - Step heading shown in the wizard header.
 * @property {string} description - Short body copy under the heading.
 * @property {string} [advanceOn] - emitTourEvent action that auto-advances past this step.
 */
export const TOUR_STEPS = [
  {
    id: "welcome",
    title: "Welcome to Sentri",
    description: "Let's get you from zero to your first running test. This takes about 2 minutes — we'll save your AI provider, create your first project, crawl it for testable pages, and generate tests you can review and approve.",
  },
  {
    id: "provider",
    title: "Step 1 of 5 — Pick an AI provider",
    description: "Sentri uses AI to generate and maintain tests. Paste an API key from Anthropic, OpenAI, or Google — or pick Ollama if you've installed it locally for free offline inference.",
    advanceOn: "provider-saved",
  },
  {
    id: "project",
    title: "Step 2 of 5 — Add your first project",
    description: "A project represents one web application. We'll start with the URL — credentials and other settings can be added later from the project page.",
    advanceOn: "project-created",
  },
  {
    id: "crawl",
    title: "Step 3 of 5 — Crawl your site",
    description: "Sentri visits your app, maps the interactive elements on each page, and writes Playwright tests for the user journeys it finds. You can stop the crawl at any point.",
    advanceOn: "crawl-complete",
  },
  {
    id: "review",
    title: "Step 4 of 5 — Review generated tests",
    description: "Each generated test gets a quality score. High-quality tests can be auto-approved; others land in the Review Queue. We'll jump you there to see what was generated.",
  },
  {
    id: "done",
    title: "Step 5 of 5 — You're set up",
    description: "Your dashboard will show pass rates, trends, and self-healing activity as tests run. You can rerun this setup any time from Account settings.",
  },
];

/**
 * Hook to manage the onboarding tour lifecycle.
 *
 * @returns {Object} tour
 * @returns {boolean}   tour.active      - Whether the tour is currently showing.
 * @returns {number}    tour.stepIndex   - Current step index (0-based).
 * @returns {TourStep}  tour.step        - Current step definition.
 * @returns {number}    tour.totalSteps  - Total number of steps.
 * @returns {Function}  tour.next        - Advance to next step (or complete).
 * @returns {Function}  tour.prev        - Go back one step.
 * @returns {Function}  tour.skip        - Dismiss the tour permanently.
 * @returns {Function}  tour.complete    - Mark tour as completed.
 * @returns {boolean}   tour.loading     - True while checking eligibility.
 */
export default function useOnboarding() {
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const activeRef = useRef(false);
  const stepRef = useRef(0);

  // Keep refs in sync so the event handler always sees latest values
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { stepRef.current = stepIndex; }, [stepIndex]);

  // ── Check eligibility on mount ────────────────────────────────────────────
  useEffect(() => {
    let alive = true;

    async function check() {
      // Force restart — set by resetOnboarding(), bypasses all checks
      const forceRestart = localStorage.getItem(FORCE_KEY);
      if (forceRestart) {
        localStorage.removeItem(FORCE_KEY);
        if (alive) { setActive(true); setStepIndex(0); setLoading(false); }
        return;
      }

      // Already completed or dismissed?
      const completed = localStorage.getItem(STORAGE_KEY);
      const dismissed = localStorage.getItem(DISMISSED_KEY);
      if (completed || dismissed) {
        if (alive) { setActive(false); setLoading(false); }
        return;
      }

      try {
        const [config, dashboard] = await Promise.all([
          api.getConfig().catch(() => null),
          api.getDashboard().catch(() => null),
        ]);

        const hasProvider = config?.hasProvider === true;
        const hasProjects = (dashboard?.totalProjects || 0) > 0;

        // Show tour only for truly new users
        if (!hasProvider && !hasProjects) {
          if (alive) { setActive(true); setStepIndex(0); }
        }
      } catch {
        // Network error — don't show tour
      } finally {
        if (alive) setLoading(false);
      }
    }

    check();
    return () => { alive = false; };
  }, []);

  // ── Listen for contextual auto-advance events ─────────────────────────────
  useEffect(() => {
    function handleTourEvent(e) {
      if (!activeRef.current) return;
      const action = e.detail?.action;
      if (!action) return;

      // Find the step whose advanceOn matches this action.
      // If the user is on that step or earlier, jump past it.
      const targetIdx = TOUR_STEPS.findIndex(s => s.advanceOn === action);
      if (targetIdx === -1) return;

      const current = stepRef.current;
      if (current <= targetIdx) {
        // Jump to the step AFTER the one that was just completed
        const nextIdx = targetIdx + 1;
        if (nextIdx < TOUR_STEPS.length) {
          setStepIndex(nextIdx);
        } else {
          localStorage.setItem(STORAGE_KEY, new Date().toISOString());
          setActive(false);
        }
      }
    }

    window.addEventListener(TOUR_EVENT, handleTourEvent);
    return () => window.removeEventListener(TOUR_EVENT, handleTourEvent);
  }, []);

  const next = useCallback(() => {
    if (stepIndex < TOUR_STEPS.length - 1) {
      setStepIndex(i => i + 1);
    } else {
      // Last step — complete
      localStorage.setItem(STORAGE_KEY, new Date().toISOString());
      setActive(false);
    }
  }, [stepIndex]);

  const prev = useCallback(() => {
    setStepIndex(i => Math.max(0, i - 1));
  }, []);

  const skip = useCallback(() => {
    localStorage.setItem(DISMISSED_KEY, new Date().toISOString());
    setActive(false);
  }, []);

  const complete = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    setActive(false);
  }, []);

  return {
    active,
    stepIndex,
    step: TOUR_STEPS[stepIndex] || null,
    totalSteps: TOUR_STEPS.length,
    next,
    prev,
    skip,
    complete,
    loading,
  };
}

/**
 * Reset onboarding so the tour shows again on next page load.
 * Intended for a "Restart tour" button in Settings.
 */
export function resetOnboarding() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(DISMISSED_KEY);
  localStorage.setItem(FORCE_KEY, "true");
}
