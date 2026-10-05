// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PortalHost, createPortals } from "./portals.tsx";
import { TOOLTIP_DELAY_MS, createTooltips } from "./tooltip.tsx";

beforeAll(() => {
  // Radix measures its anchor; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function setup() {
  const portals = createPortals();
  render(<PortalHost portals={portals} />);
  const target = document.createElement("button");
  document.body.appendChild(target);
  return { setupTooltip: createTooltips(portals), target };
}

const tooltipText = () => document.querySelector("[data-wb-tooltip]")?.textContent ?? null;

describe("setupTooltip", () => {
  it("shows an instant tooltip with its detail line and hides it on leave", async () => {
    const { setupTooltip, target } = setup();
    setupTooltip(target, "Viewed", { instant: true, detail: "3 of 5 files" });

    act(() => target.dispatchEvent(new Event("pointerenter")));
    expect(await screen.findAllByText("Viewed")).not.toHaveLength(0);
    expect(tooltipText()).toContain("3 of 5 files");

    act(() => target.dispatchEvent(new Event("pointerleave")));
    expect(tooltipText()).toBeNull();
  });

  it("waits for the hover delay unless instant", () => {
    vi.useFakeTimers();
    const { setupTooltip, target } = setup();
    setupTooltip(target, "Open in Diffs");

    act(() => target.dispatchEvent(new Event("pointerenter")));
    expect(tooltipText()).toBeNull();
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
    expect(tooltipText()).toContain("Open in Diffs");
  });

  it("hides on Escape while focus is elsewhere", async () => {
    const { setupTooltip, target } = setup();
    setupTooltip(target, "Diff settings", { instant: true });

    act(() => target.dispatchEvent(new Event("pointerenter")));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Diff settings");

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows on keyboard focus but not on the focus a click brings", () => {
    const { setupTooltip, target } = setup();
    setupTooltip(target, "Viewed", { instant: true });
    const focusVisible = vi.spyOn(target, "matches").mockReturnValue(false);

    act(() => {
      target.dispatchEvent(new Event("pointerdown"));
      target.dispatchEvent(new Event("focusin"));
    });
    expect(tooltipText()).toBeNull();

    focusVisible.mockReturnValue(true);
    act(() => target.dispatchEvent(new Event("focusin")));
    expect(tooltipText()).toContain("Viewed");
  });

  it("shows nothing over the menu its button has open", () => {
    const { setupTooltip, target } = setup();
    setupTooltip(target, "Diff settings", { instant: true });
    target.setAttribute("aria-expanded", "true");

    act(() => target.dispatchEvent(new Event("pointerenter")));
    expect(tooltipText()).toBeNull();
  });

  it("removes its listeners and the body host on dispose", () => {
    const { setupTooltip, target } = setup();
    const tooltip = setupTooltip(target, "Viewed", { instant: true });
    act(() => target.dispatchEvent(new Event("pointerenter")));
    expect(document.querySelector("[data-wb-tooltip-host]")).not.toBeNull();

    act(() => tooltip.dispose());
    expect(document.querySelector("[data-wb-tooltip-host]")).toBeNull();
    act(() => target.dispatchEvent(new Event("pointerenter")));
    expect(tooltipText()).toBeNull();
  });
});
