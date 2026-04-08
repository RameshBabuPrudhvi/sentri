/**
 * @module hooks/useOnboarding
 * @description Manages onboarding tour state: step progression, completion
 * persistence, and skip/dismiss logic.
 *
 * Tour is shown when ALL of these are true:
 *   1. User has never completed or dismissed the tour (localStorage flag)
 *   2. No AI provider is configured yet (config.hasProvider === false)
 *   3. No projects exist yet (totalProjects === 0)
 *
 * The tour can be re-triggered from Settings by clearing the localStorage flag.
 *
 * @example
 * const tour = useOnboarding();
 * if (tour.active) renderTooltipAt(tour.currentStep);
 */

import { useState, useEffect, useCallback } from "react";
import { api } from "../api.js";

const STORAGE_KEY = "sentri_onboarding_completed";
const DISMISSED_KEY = "sentri_onboarding_dismissed";

/**
 * Ordered tour steps. Each step targets a DOM element via `data-tour` attribute
 * or a CSS selector fallback, and provides copy + CTA for the tooltip.
 *
 * @typedef {Object} TourStep
 * @property {string}  id          - Unique step identifier.
 * @property {string}  target      - Value of `data-tour` attribute on the anchor element.
 * @property {string}  title       - Tooltip heading.
 * @property {string}  description - Tooltip body text.
 * @property {string}  cta         - Call-to-action button label.
 * @property {string}  [route]     - If set, navigate here before showing the step.
 * @property {"top"|"bottom"|"left"|"right"} [placement] - Tooltip placement relative to target.
 */
export const TOUR_STEPS = [
  {
    id: "welcome",
    target: "tour-welcome",
    title: "Welcome to Sentri! 👋",
    description: "Let's get you set up in under 2 minutes. We'll walk you through configuring your AI provider, creating your first project, and generating tests.",
    cta: "Let's go",
    placement: "bottom",
  },
  {
    id: "settings",
    target: "tour-settings",
    title: "Step 1: Configure AI Provider",
    description: "Sentri uses AI to generate and maintain tests. Add an API key for Claude, GPT-4, Gemini, or use Ollama for free local inference.",
    cta: "Go to Settings",
    route: "/settings",
    placement: "right",
  },
  {
    id: "create-project",
    target: "tour-projects",
    title: "Step 2: Create a Project",
    description: "A project represents your web application. Enter your app's URL and optional login credentials — Sentri will crawl and understand your app.",
    cta: "Go to Projects",
    route: "/projects",
    placement: "right",
  },
  {
    id: "crawl-or-test",
    target: "tour-tests",
    title: "Step 3: Generate Tests",
    description: "You have two options: crawl your app to auto-discover pages and generate tests, or go to Tests and describe what you want to test in plain English.",
    cta: "Go to Tests",
    route: "/tests",
    placement: "right",
  },
  {
    id: "done",
    target: "tour-dashboard",
    title: "You're all set! 🎉",
    description: "Your dashboard will show pass rates, trends, and recent activity once tests start running. Happy testing!",
    cta: "Start using Sentri",
    route: "/dashboard",
    placement: "right",
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

  // Check eligibility on mount
  useEffect(() => {
    let alive = true;

    async function check() {
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
}
