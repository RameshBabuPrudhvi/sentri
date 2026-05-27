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
    // Toast pill remains in DOM (opacity transition), but pointer-events
    // are gone — assert on the visibility prop indirectly via the style.
    const pill = screen.getByText("Saved").parentElement;
    expect(pill).toHaveStyle({ opacity: "1" });
    act(() => vi.advanceTimersByTime(3500));
    expect(pill).toHaveStyle({ opacity: "0" });
  });

  it("error toast lingers 5s, not 3.5s", () => {
    render(
      <MemoryRouter>
        <ToastProvider><Harness /></ToastProvider>
      </MemoryRouter>
    );
    act(() => screen.getByText("fire-error").click());
    const pill = screen.getByText("Boom").parentElement;
    act(() => vi.advanceTimersByTime(3500));
    expect(pill).toHaveStyle({ opacity: "1" }); // still visible
    act(() => vi.advanceTimersByTime(1500));
    expect(pill).toHaveStyle({ opacity: "0" });
  });

  it("useToast() throws outside the provider", () => {
    // Suppress React's expected-error console noise for this assertion.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function NakedConsumer() { useToast(); return null; }
    expect(() => render(<NakedConsumer />)).toThrow(/inside <ToastProvider>/);
    spy.mockRestore();
  });
});
