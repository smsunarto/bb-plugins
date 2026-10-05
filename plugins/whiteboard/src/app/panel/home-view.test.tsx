// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewApiSummary } from "../../shared/vendor/review-protocol/src/index.ts";
import { ReviewHome } from "../vendor/review/app/src/review-home-view.tsx";

const summary = (index: number, title: string): ReviewApiSummary => ({
  reviewId: `s${index}`,
  version: 1,
  title,
  createdAt: `2026-10-0${index}T12:00:00.000Z`,
  repositoryName: "bb-plugins",
  viewedAt: null,
  dismissedAt: null,
});

const SESSIONS = [
  summary(1, "Plan: ambient agents"),
  summary(2, "Codex resets"),
  summary(3, "Diff lens walkthrough"),
  summary(4, "Auth flow"),
  summary(5, "Sequence of a deploy"),
  summary(6, ""),
];

/** Cmd+F, as bb's window sees it on a Mac. */
const findKey = () =>
  new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true });

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  render(
    <div className="review-canvas-root">
      <ReviewHome reviews={SESSIONS} onOpen={() => {}} />
    </div>,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Home", () => {
  it("names the list Whiteboards", () => {
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Whiteboards");
    expect(screen.getByText("6 whiteboards")).toBeTruthy();
    expect(screen.getByText("Untitled whiteboard")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search whiteboards" }), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No whiteboards match “zzz”.")).toBeTruthy();
  });

  it("leaves Cmd+F to bb when focus is outside the canvas", () => {
    const event = findKey();
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("jumps to the search on Cmd+F inside the canvas", () => {
    const event = findKey();
    screen.getByRole("heading", { level: 1 }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole("searchbox", { name: "Search whiteboards" }),
    );
  });
});
