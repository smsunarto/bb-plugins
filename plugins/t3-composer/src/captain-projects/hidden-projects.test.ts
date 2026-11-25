// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERSONAL_PROJECT_ID,
  fallbackProjectId,
  hiddenProjectIds,
  publishHiddenProjectIds,
  resetHiddenProjects,
  subscribeHiddenProjectIds,
} from "./hidden-projects";

beforeEach(() => {
  localStorage.clear();
  resetHiddenProjects();
});

describe("fallbackProjectId", () => {
  it("leaves a visible or unresolved project alone", () => {
    expect(fallbackProjectId("proj_a", ["proj_captains"], null)).toBeNull();
    expect(fallbackProjectId(null, ["proj_captains"], null)).toBeNull();
    expect(fallbackProjectId("proj_captains", [], null)).toBeNull();
  });

  it("moves a remembered Captains project to the personal project", () => {
    expect(fallbackProjectId("proj_captains", ["proj_captains"], null)).toBe(PERSONAL_PROJECT_ID);
  });

  it("moves back to the last visible project when there is one", () => {
    expect(fallbackProjectId("proj_captains", ["proj_captains"], "proj_a")).toBe("proj_a");
  });

  it("never moves to a project that is itself hidden", () => {
    expect(fallbackProjectId("proj_c1", ["proj_c1", "proj_c2"], "proj_c2")).toBe(
      PERSONAL_PROJECT_ID,
    );
  });
});

describe("publishHiddenProjectIds", () => {
  it("dedupes, and tells listeners only about a real change", () => {
    const listener = vi.fn();
    subscribeHiddenProjectIds(listener);
    publishHiddenProjectIds(["proj_b", "proj_a", "proj_b"]);
    expect(hiddenProjectIds()).toEqual(["proj_a", "proj_b"]);
    publishHiddenProjectIds(["proj_a", "proj_b"]);
    expect(listener).toHaveBeenCalledTimes(1);
    publishHiddenProjectIds([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the ids for the next page load on this server", () => {
    publishHiddenProjectIds(["proj_captains"]);
    resetHiddenProjects();
    expect(hiddenProjectIds()).toEqual(["proj_captains"]);
    expect(Object.keys(localStorage)).toEqual([
      `t3-composer.captain-project-ids:${location.origin}`,
    ]);
    publishHiddenProjectIds([]);
    resetHiddenProjects();
    expect(hiddenProjectIds()).toEqual([]);
  });

  it("ignores a cache it cannot read", () => {
    localStorage.setItem(`t3-composer.captain-project-ids:${location.origin}`, "{not json");
    resetHiddenProjects();
    expect(hiddenProjectIds()).toEqual([]);
  });
});
