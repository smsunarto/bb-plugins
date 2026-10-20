import { describe, expect, test } from "bun:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { filterHiddenMachines, machineVisibility, sidebarMachines } from "../lib/machines";
import { filterByProject } from "../lib/inbox";

const threads = [
  { id: "one", projectId: "repo-a", host: { id: "host-a", name: "Studio" } },
  { id: "two", projectId: "repo-b", host: { id: "host-a", name: "Studio" } },
  { id: "three", projectId: "repo-a", host: { id: "host-b", name: "Studio" } },
  { id: "four", projectId: "repo-a", host: null },
] as PluginSidebarThread[];

describe("sidebar machines", () => {
  test("deduplicates by identity, preserving machines with matching names", () => {
    expect(sidebarMachines(threads)).toEqual([
      { id: "host-a", name: "Studio" },
      { id: "host-b", name: "Studio" },
    ]);
  });

  test("lists known machines without threads, preferring their current names", () => {
    expect(
      sidebarMachines(threads, [
        { id: "host-b", name: "Renamed" },
        { id: "host-c", name: "Empty" },
      ]),
    ).toEqual([
      { id: "host-c", name: "Empty" },
      { id: "host-b", name: "Renamed" },
      { id: "host-a", name: "Studio" },
    ]);
  });

  test("hides selected machines while preserving threads without a known host", () => {
    expect(
      filterByProject(filterHiddenMachines(threads, new Set(["host-b"])), "repo-a").map(
        (t) => t.id,
      ),
    ).toEqual(["one", "four"]);
    expect(filterHiddenMachines(threads, new Set(["host-a"])).map((t) => t.id)).toEqual([
      "three",
      "four",
    ]);
    expect(filterHiddenMachines(threads, new Set(["disconnected"]))).toEqual(threads);
    expect(filterHiddenMachines(threads, new Set())).toBe(threads);
  });

  test("new machines are visible and absent hidden IDs do not activate filtering", () => {
    const machines = sidebarMachines(threads);
    const all = machineVisibility(machines, ["retired"]);
    expect(all.active).toBe(false);
    expect(all.composerHostId).toBeUndefined();
    expect(all.visible).toEqual(machines);
    const filtered = machineVisibility([...machines, { id: "new", name: "New" }], ["host-a"]);
    expect(filtered.visible.map((machine) => machine.id)).toEqual(["host-b", "new"]);
    expect(filtered.active).toBe(true);
    expect(filtered.composerHostId).toBeUndefined();
  });

  test("only an active filter with one visible machine preselects the composer", () => {
    const machines = sidebarMachines(threads);
    expect(machineVisibility(machines, ["host-b"]).composerHostId).toBe("host-a");
    expect(machineVisibility([machines[0]!], []).composerHostId).toBeUndefined();
    expect(machineVisibility([], ["retired"]).active).toBe(false);
  });

  test("shows every machine rather than none when the saved list hides them all", () => {
    const machines = sidebarMachines(threads);
    const visibility = machineVisibility(machines, ["host-a", "host-b"]);
    expect(visibility.active).toBe(false);
    expect(visibility.visible).toEqual(machines);
    expect(filterHiddenMachines(threads, visibility.hiddenMachineIds)).toBe(threads);
  });
});
