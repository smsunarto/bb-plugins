import { describe, expect, test } from "bun:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { filterByMachine, machineColor, sidebarMachines } from "../lib/machines";
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

  test("keeps machine colors stable when labels and roster order change", () => {
    const renamed = sidebarMachines([
      { ...threads[2]!, host: { id: "host-b", name: "Alpha" } },
      { ...threads[0]!, host: { id: "host-a", name: "Zulu" } },
    ]);
    expect(renamed.map((host) => [host.id, machineColor(host.id)])).toEqual([
      ["host-b", "var(--ansi-6)"],
      ["host-a", "var(--ansi-4)"],
    ]);
  });
});
