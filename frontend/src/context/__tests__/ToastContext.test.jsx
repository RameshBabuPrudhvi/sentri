/**
 * @module context/__tests__/ToastContext
 * @description Unit test for the global toast provider (UX-001).
 *
 * Pins:
 *   - showToast() flips the toast to visible with the right msg + type.
 *   - Auto-dismiss timing (3.5s for success/info, 5s for error).
 *   - useToast() throws outside the provider — guards against the silent-
 *     failure pattern that's already bitten us on `/automation`.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider, useToast } from "../ToastContext.jsx";

function Harness() {
  const { showToast } = useToast();
  return (
    <>
      <button onClick={() => showToast("Saved", "success")}>fire-success</button>
      <button onClick={() => showToast("Boom", "error")}>fire-error</button>
    </>
  );
}

describe("ToastContext", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renders the toast message after showToast()", () => {
    render(
      <MemoryRouter>
        <ToastProvider><Harness /></ToastProvider>
      </MemoryRouter>
    );
    act(() => screen.getByText("fire-success").click());
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("auto-dismisses success toast after 3.5s", () => {
    render(
      <MemoryRouter>
        <ToastProvider><Harness /></ToastProvider>
      </MemoryRouter>
    );
    act(() => screen.getByText("fire-success").click());
    // Visibility is driven by `aria-hidden` (the CSS hook the toast
    // partial reads — `frontend/src/styles/components/run-toast.css`).
    // JSDOM doesn't load the stylesheet, so we assert on the attribute
    // directly rather than `toHaveStyle({ opacity })`.
    const pill = screen.getByText("Saved").closest(".rt-toast");
    expect(pill).toHaveAttribute("aria-hidden", "false");
    act(() => vi.advanceTimersByTime(3500));
    expect(pill).toHaveAttribute("aria-hidden", "true");
  });

  it("error toast lingers 5s, not 3.5s", () => {
    render(
      <MemoryRouter>
        <ToastProvider><Harness /></ToastProvider>
      </MemoryRouter>
    );
    act(() => screen.getByText("fire-error").click());
    const pill = screen.getByText("Boom").closest(".rt-toast");
    act(() => vi.advanceTimersByTime(3500));
    expect(pill).toHaveAttribute("aria-hidden", "false"); // still visible
    act(() => vi.advanceTimersByTime(1500));
    expect(pill).toHaveAttribute("aria-hidden", "true");
  });

  it("error toast uses role=alert + aria-live=assertive (WAI-ARIA)", () => {
    render(
      <MemoryRouter>
        <ToastProvider><Harness /></ToastProvider>
      </MemoryRouter>
    );
    act(() => screen.getByText("fire-error").click());
    const pill = screen.getByText("Boom").closest(".rt-toast");
    expect(pill).toHaveAttribute("role", "alert");
    expect(pill).toHaveAttribute("aria-live", "assertive");
    expect(pill).toHaveAttribute("data-toast-type", "error");
  });

  it("success toast uses role=status + aria-live=polite (WAI-ARIA)", () => {
    render(
      <MemoryRouter>
        <ToastProvider><Harness /></ToastProvider>
      </MemoryRouter>
    );
    act(() => screen.getByText("fire-success").click());
    const pill = screen.getByText("Saved").closest(".rt-toast");
    expect(pill).toHaveAttribute("role", "status");
    expect(pill).toHaveAttribute("aria-live", "polite");
    expect(pill).toHaveAttribute("data-toast-type", "success");
  });

  it("useToast() throws outside the provider", () => {
    // Suppress React's expected-error console noise for this assertion.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function NakedConsumer() { useToast(); return null; }
    expect(() => render(<NakedConsumer />)).toThrow(/inside <ToastProvider>/);
    spy.mockRestore();
  });
});
