import { describe, expect, test } from "bun:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { filterByMachine, sidebarMachines } from "../lib/machines";
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

  test("filters machine and project together without treating unknown hosts as local", () => {
    expect(filterByProject(filterByMachine(threads, "host-a"), "repo-a").map((t) => t.id)).toEqual([
      "one",
    ]);
    expect(filterByMachine(threads, "host-b").map((t) => t.id)).toEqual(["three"]);
    expect(filterByMachine(threads, "disconnected")).toEqual([]);
    expect(filterByMachine(threads, null).map((t) => t.id)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
  });
});
