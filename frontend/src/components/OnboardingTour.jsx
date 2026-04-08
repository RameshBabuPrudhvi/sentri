/**
 * @module components/OnboardingTour
 * @description Full-screen onboarding tour overlay with spotlight highlighting,
 * animated tooltip popovers, step indicators, and keyboard navigation.
 *
 * All visual styles live in index.css under the `.tour-*` namespace.
 * Only dynamic positioning (computed from target element rect) uses inline style.
 *
 * @example
 * <OnboardingTour tour={tour} />
 */

import React, { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { ChevronRight, ChevronLeft, X, Sparkles } from "lucide-react";

const TOOLTIP_WIDTH = 360;
const TOOLTIP_GAP = 14;
const SPOTLIGHT_PADDING = 8;
const SPOTLIGHT_RADIUS = 12;

/**
 * @param {Object} props
 * @param {Object} props.tour - Return value of useOnboarding() hook.
 */
export default function OnboardingTour({ tour }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [rect, setRect] = useState(null);
  const [visible, setVisible] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const tooltipRef = useRef(null);
  const prevStepRef = useRef(-1);

  const { active, step, stepIndex, totalSteps, next, prev, skip } = tour;

  // ── Navigate to step's route if needed ────────────────────────────────────
  useEffect(() => {
    if (!active || !step?.route) return;
    if (location.pathname !== step.route) {
      navigate(step.route);
    }
  }, [active, step, location.pathname, navigate]);

  // ── Find and track the target element ─────────────────────────────────────
  const updateRect = useCallback(() => {
    if (!active || !step) { setRect(null); return; }
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    } else {
      setRect(null);
    }
  }, [active, step]);

  useEffect(() => {
    if (!active) { setVisible(false); return; }

    // Transition animation between steps
    if (prevStepRef.current !== stepIndex) {
      setTransitioning(true);
      const timer = setTimeout(() => {
        setTransitioning(false);
        prevStepRef.current = stepIndex;
      }, 250);
      return () => clearTimeout(timer);
    }

    // Delay initial appearance for smooth entry
    const showTimer = setTimeout(() => setVisible(true), 100);

    // Poll for target element (it may render after route navigation)
    updateRect();
    const poll = setInterval(updateRect, 200);
    window.addEventListener("resize", updateRect);
    window.addEventListener("scroll", updateRect, true);

    return () => {
      clearTimeout(showTimer);
      clearInterval(poll);
      window.removeEventListener("resize", updateRect);
      window.removeEventListener("scroll", updateRect, true);
    };
  }, [active, stepIndex, transitioning, updateRect]);

  // ── Keyboard navigation ───────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    function handleKey(e) {
      if (e.key === "Escape") { skip(); return; }
      if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); return; }
      if (e.key === "ArrowLeft" && stepIndex > 0) { e.preventDefault(); prev(); return; }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [active, next, prev, skip, stepIndex]);

  if (!active || !step || !visible) return null;

  // ── Compute tooltip position ──────────────────────────────────────────────
  const isMobile = window.innerWidth <= 480;
  const placement = step.placement || "bottom";
  let tooltipStyle = {};

  if (isMobile) {
    // On mobile the CSS pins left/width via !important; just set vertical pos.
    // Place tooltip below the target if visible, otherwise near bottom of screen.
    tooltipStyle = rect
      ? { top: Math.min(rect.top + rect.height + TOOLTIP_GAP, window.innerHeight - 280) }
      : { bottom: 16 };
  } else if (rect) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    // Estimate tooltip height (~300px) and clamp so it never overflows viewport
    const TOOLTIP_HEIGHT_EST = 320;
    const maxTop = window.innerHeight - TOOLTIP_HEIGHT_EST - 16;

    if (placement === "right") {
      tooltipStyle = {
        top: Math.min(Math.max(16, cy - 80), maxTop),
        left: Math.min(rect.left + rect.width + TOOLTIP_GAP, window.innerWidth - TOOLTIP_WIDTH - 16),
      };
    } else if (placement === "left") {
      tooltipStyle = {
        top: Math.min(Math.max(16, cy - 80), maxTop),
        left: Math.max(16, rect.left - TOOLTIP_WIDTH - TOOLTIP_GAP),
      };
    } else if (placement === "top") {
      tooltipStyle = {
        top: Math.max(16, rect.top - TOOLTIP_HEIGHT_EST),
        left: Math.max(16, Math.min(cx - TOOLTIP_WIDTH / 2, window.innerWidth - TOOLTIP_WIDTH - 16)),
      };
    } else {
      tooltipStyle = {
        top: Math.min(rect.top + rect.height + TOOLTIP_GAP, maxTop),
        left: Math.max(16, Math.min(cx - TOOLTIP_WIDTH / 2, window.innerWidth - TOOLTIP_WIDTH - 16)),
      };
    }
  } else {
    // No target found — center the tooltip
    tooltipStyle = {
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
    };
  }

  const isLastStep = stepIndex === totalSteps - 1;
  const progressPct = ((stepIndex + 1) / totalSteps) * 100;

  return (
    <div
      className={`tour-overlay${transitioning ? " tour-overlay--transitioning" : ""}`}
      aria-label="Onboarding tour"
      role="dialog"
      aria-modal="true"
    >
      {/* ── Backdrop with spotlight cutout ── */}
      <svg
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        onClick={skip}
      >
        <defs>
          <mask id="tour-spotlight-mask">
            <rect width="100%" height="100%" fill="white" />
            {rect && (
              <rect
                x={rect.left - SPOTLIGHT_PADDING}
                y={rect.top - SPOTLIGHT_PADDING}
                width={rect.width + SPOTLIGHT_PADDING * 2}
                height={rect.height + SPOTLIGHT_PADDING * 2}
                rx={SPOTLIGHT_RADIUS}
                ry={SPOTLIGHT_RADIUS}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(0, 0, 0, 0.6)"
          mask="url(#tour-spotlight-mask)"
        />
      </svg>

      {/* ── Spotlight ring ── */}
      {rect && (
        <div
          className="tour-spotlight-ring"
          style={{
            top: rect.top - SPOTLIGHT_PADDING,
            left: rect.left - SPOTLIGHT_PADDING,
            width: rect.width + SPOTLIGHT_PADDING * 2,
            height: rect.height + SPOTLIGHT_PADDING * 2,
          }}
        />
      )}

      {/* ── Tooltip card ── */}
      <div
        ref={tooltipRef}
        className="tour-tooltip"
        onClick={e => e.stopPropagation()}
        style={tooltipStyle}
      >
        {/* Progress bar */}
        <div
          className="tour-progress-bar"
          style={{ background: `linear-gradient(90deg, #6366f1 ${progressPct}%, var(--border) 0%)` }}
        />

        {/* Header */}
        <div className="tour-header">
          <div className="tour-icon-box">
            <Sparkles size={18} color="#fff" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tour-title">{step.title}</div>
            <div className="tour-step-label">Step {stepIndex + 1} of {totalSteps}</div>
          </div>
          <button className="tour-close" onClick={skip} title="Skip tour (Esc)">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="tour-body">{step.description}</div>

        {/* Step dots */}
        <div className="tour-dots">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              className={`tour-dot${
                i === stepIndex ? " tour-dot--active" :
                i < stepIndex  ? " tour-dot--done"   :
                                 " tour-dot--pending"
              }`}
            />
          ))}
        </div>

        {/* Actions */}
        <div className="tour-actions">
          {stepIndex > 0 && (
            <button className="tour-btn-back" onClick={prev}>
              <ChevronLeft size={14} /> Back
            </button>
          )}
          <div style={{ flex: 1 }} />
          {!isLastStep && (
            <button className="tour-btn-skip" onClick={skip}>Skip tour</button>
          )}
          <button className="tour-btn-next" onClick={next}>
            {step.cta}
            {!isLastStep && <ChevronRight size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
