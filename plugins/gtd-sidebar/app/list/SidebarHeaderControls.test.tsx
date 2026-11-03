// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { SIDEBAR_CONTROL_STATE_CLASS } from "@/components/ui/sidebar-row-classes";
import { ActionMenuItem } from "@/components/ui/action-menu-items";
import {
  sidebarChronologicalSortAtom,
  sidebarOrganizationModeAtom,
  sidebarEnvironmentGroupingAtom,
  sidebarSortDirectionAtom,
  sidebarShowRowMetadataAtom,
} from "../preferences/atoms.js";
import type { OrganizationMode } from "../../shared/preferences.js";
import { GtdFilterProvider, type GtdFilterState } from "../gtd/GtdFilters.js";
import { projectScopeAtom } from "../gtd/useGtdShelves.js";

installTestPluginRuntime();
const { SidebarHeaderControls } = await import("./SidebarHeaderControls.js");

afterEach(() => {
  cleanup();
});

function setup(
  label = "Pinned",
  section = false,
  organization: OrganizationMode = "project",
  compact = false,
  experiments: string[] = [],
  filters: GtdFilterState | null = null,
  newThreadLast = false,
) {
  const store = createStore();
  store.set(sidebarOrganizationModeAtom, organization);
  store.set(sidebarChronologicalSortAtom, "updated");
  store.set(sidebarSortDirectionAtom, "default");
  store.set(sidebarEnvironmentGroupingAtom, "auto");
  store.set(sidebarShowRowMetadataAtom, false);
  const newThread = vi.fn();
  const rename = vi.fn();
  const Harness = () => (
    <Provider store={store}>
      <CompactViewportOverrideProvider isCompactViewport={compact}>
        <TooltipProvider>
          <GtdFilterProvider value={filters}>
            <SidebarHeaderControls
              label={label}
              onNewThread={newThread}
              newThreadLast={newThreadLast}
            >
              {section && (
                <ActionMenuItem surface="dropdown" icon="Edit" onSelect={rename}>
                  Rename
                </ActionMenuItem>
              )}
            </SidebarHeaderControls>
          </GtdFilterProvider>
        </TooltipProvider>
      </CompactViewportOverrideProvider>
    </Provider>
  );
  renderSlot({ component: Harness }, {}, { experiments });
  return { store, newThread, rename };
}

async function openMenu(label = "Pinned") {
  fireEvent.keyDown(
    screen.getByRole("button", {
      name: new RegExp(`^${label} actions(?:;|$)`),
    }),
    {
      key: "Enter",
    },
  );
  await screen.findByRole("menuitem", { name: "Organize" });
}

async function openSubmenu(label: string) {
  fireEvent.keyDown(screen.getByRole("menuitem", { name: label }), {
    key: "ArrowRight",
  });
}

describe("sidebar header controls", () => {
  it("supports keyboard selection when the menu first loads", async () => {
    const { store } = setup("Pinned", false, "chronological");
    await openMenu();
    const organize = screen.getByRole("menuitem", { name: "Organize" });
    fireEvent.keyDown(organize.closest('[role="menu"]')!, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(organize));
    await openSubmenu("Organize");
    const project = await screen.findByRole("menuitemradio", {
      name: "By project",
    });
    fireEvent.keyDown(project.closest('[role="menu"]')!, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(project));
    fireEvent.keyDown(project, { key: "Enter" });
    expect(store.get(sidebarOrganizationModeAtom)).toBe("project");
  });

  it("dismisses on the first outside click after toggling environment grouping", async () => {
    setup();
    await openMenu();
    await openSubmenu("Organize");
    const toggle = await screen.findByRole("menuitemcheckbox", {
      name: "By environment",
    });
    fireEvent.pointerDown(toggle, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(toggle, { button: 0, pointerType: "mouse" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(document.body, { button: 0, pointerType: "mouse" });
    fireEvent.click(document.body);
    await waitFor(() => {
      expect(screen.queryByRole("menuitemcheckbox", { name: "By environment" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Organize" })).toBeNull();
    });
  });

  it("keeps the primary before overflow and applies the shared control state", async () => {
    const { newThread } = setup("Pinned", false, "chronological");
    const primary = screen.getByRole("button", {
      name: "New thread in Pinned",
    });
    expect(primary.nextElementSibling?.getAttribute("aria-label")).toBe("Pinned actions");
    for (const control of [primary, primary.nextElementSibling]) {
      for (const token of SIDEBAR_CONTROL_STATE_CLASS.split(" ")) {
        expect(control?.classList.contains(token)).toBe(true);
      }
      expect(control?.classList.contains("hover:bg-sidebar-accent")).toBe(false);
      expect(control?.classList.contains("hover:text-foreground")).toBe(false);
      expect(control?.classList.contains("focus-visible:ring-1")).toBe(true);
      expect(control?.classList.contains("focus-visible:ring-ring")).toBe(true);
      expect(control?.className).not.toMatch(/focus-visible:(bg-|ring-[02]\b)/);
    }
    expect(primary.classList.contains("max-md:pointer-coarse:w-8")).toBe(true);
    expect(primary.nextElementSibling?.classList.contains("max-md:pointer-coarse:w-9")).toBe(true);
    expect(primary.parentElement?.classList.contains("max-md:pointer-coarse:gap-0")).toBe(true);
    fireEvent.click(primary);
    expect(newThread).toHaveBeenCalledOnce();
    await openMenu();
    expect(primary.nextElementSibling?.getAttribute("data-state")).toBe("open");
  });

  it("puts a shelf's menu first and New thread at the edge", () => {
    setup("Waiting", false, "project", false, [], null, true);
    const menu = screen.getByRole("button", { name: "Waiting actions" });
    expect(menu.nextElementSibling?.getAttribute("aria-label")).toBe("New thread in Waiting");
  });

  it("lists the view pages, then the header's own items", async () => {
    const { rename } = setup("Review", true);
    await openMenu("Review");
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Organize",
      "Sort by",
      "Filter",
      "Rename",
    ]);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(rename).toHaveBeenCalledOnce();
  });

  it("keeps Organize open and exclusive across selections", async () => {
    const { store } = setup();
    await openMenu();
    await openSubmenu("Organize");
    const machine = await screen.findByRole("menuitemradio", {
      name: "By machine",
    });
    expect(
      screen.getByRole("menuitemradio", { name: "By project" }).getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(machine);
    expect(store.get(sidebarOrganizationModeAtom)).toBe("machine");
    await waitFor(() =>
      expect(
        screen.getByRole("menuitemradio", { name: "By machine" }).getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(
      screen.getByRole("menuitemradio", { name: "By project" }).getAttribute("aria-checked"),
    ).toBe("false");

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Flat" }));
    expect(store.get(sidebarOrganizationModeAtom)).toBe("chronological");
    await waitFor(() =>
      expect(screen.getByRole("menuitemradio", { name: "Flat" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
  });

  it("preserves the existing Organize groups without a Reset action", async () => {
    const { store } = setup("Pinned", false, "chronological");
    act(() => store.set(sidebarEnvironmentGroupingAtom, true));
    await openMenu();
    await openSubmenu("Organize");
    const grouping = await screen.findByRole("menuitemcheckbox", {
      name: "By environment",
    });
    expect(screen.getByRole("group", { name: "Groups" })).toBeTruthy();
    expect(grouping.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(grouping);
    expect(store.get(sidebarEnvironmentGroupingAtom)).toBe(false);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "By project" }));
    expect(store.get(sidebarOrganizationModeAtom)).toBe("project");
    expect(store.get(sidebarEnvironmentGroupingAtom)).toBe(false);
    expect(screen.queryByRole("menuitem", { name: /^Reset/ })).toBeNull();
  });

  it("drops the Rows group while row metadata's experiment is off", async () => {
    setup();
    await openMenu();
    await openSubmenu("Organize");
    await screen.findByRole("menuitemcheckbox", { name: "By read status" });
    expect(screen.queryByRole("group", { name: "Rows" })).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Provider icons" })).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Metadata" })).toBeNull();
  });

  it("toggles row metadata in the Organize Rows group", async () => {
    const { store } = setup("Pinned", false, "project", false, ["threadRowMetadata"]);
    await openMenu();
    await openSubmenu("Organize");
    const toggle = await screen.findByRole("menuitemcheckbox", {
      name: "Metadata",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(store.get(sidebarShowRowMetadataAtom)).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("resolves legacy sort, toggles direction, and resets it for another field", async () => {
    const { store } = setup();
    act(() => store.set(sidebarChronologicalSortAtom, "none"));
    await openMenu();
    await openSubmenu("Sort by");
    const updated = await screen.findByRole("menuitemradio", {
      name: "Updated at, descending. Sort ascending",
    });
    expect(updated.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(updated);
    expect(store.get(sidebarSortDirectionAtom)).toBe("ascending");
    fireEvent.click(
      screen.getByRole("menuitemradio", {
        name: "Updated at, ascending. Sort descending",
      }),
    );
    expect(store.get(sidebarSortDirectionAtom)).toBe("descending");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Alphabetical" }));
    expect(store.get(sidebarChronologicalSortAtom)).toBe("alpha");
    expect(store.get(sidebarSortDirectionAtom)).toBe("ascending");
    expect(screen.queryByRole("menuitem", { name: /^Reset/ })).toBeNull();
    expect(
      screen
        .getByRole("menuitemradio", {
          name: "Alphabetical, ascending. Sort descending",
        })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("announces compact sort direction and resets the nested page after closing", async () => {
    const { store } = setup("Pinned", false, "project", true);
    fireEvent.click(screen.getByRole("button", { name: /^Pinned actions(?:;|$)/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sort by" }));
    fireEvent.click(
      await screen.findByRole("menuitemradio", {
        name: /Updated at\s*, descending\. Sort ascending/,
      }),
    );
    expect(store.get(sidebarSortDirectionAtom)).toBe("ascending");
    expect(
      screen
        .getByRole("menuitemradio", {
          name: /Updated at\s*, ascending\. Sort descending/,
        })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Back" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Organize" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Flat" }));
    expect(store.get(sidebarOrganizationModeAtom)).toBe("chronological");
    expect(screen.getByRole("menuitemradio", { name: "Flat" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /^Pinned actions(?:;|$)/ }));
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Back" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^Pinned actions(?:;|$)/ }));
    expect(await screen.findByRole("menuitem", { name: "Organize" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Back" })).toBeNull();
  });
});

it.each([false, true])("filters by project and machine (compact=%s)", async (compact) => {
  const changeMachines = vi.fn();
  const filters: GtdFilterState = {
    projects: [
      { id: "proj_a", name: "Alpha" },
      { id: "proj_b", name: "Beta" },
    ],
    scope: null,
    machines: [
      { id: "host_a", name: "Laptop" },
      { id: "host_b", name: "Server" },
    ],
    hiddenMachineIds: new Set(["host_b"]),
    changeMachines,
  };
  const { store } = setup("Pinned", false, "project", compact, [], filters);
  if (compact) {
    fireEvent.click(screen.getByRole("button", { name: /^Pinned actions(?:;|$)/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Filter" }));
  } else {
    await openMenu();
    await openSubmenu("Filter");
  }
  const all = await screen.findByRole("menuitemradio", { name: "All projects" });
  expect(all.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Beta" }));
  expect(store.get(projectScopeAtom)).toBe("proj_b");

  const laptop = screen.getByRole("menuitemcheckbox", { name: "Laptop" });
  expect(laptop.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(laptop);
  expect(changeMachines).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Server" }));
  expect(changeMachines).toHaveBeenLastCalledWith({
    kind: "set",
    machineId: "host_b",
    visible: true,
    machineIds: ["host_a", "host_b"],
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "Show all machines" }));
  expect(changeMachines).toHaveBeenLastCalledWith({ kind: "all" });
});
