import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dataKey, parseDataFile, type LoadedData } from "./data";
import { specToMarkdown } from "./markdown";

/** The markdown of `source` with `files` (gallery/data names) loaded as Load reads them. */
function markdown(source: string, ...files: string[]): string {
  const data = new Map<string, LoadedData>();
  for (const file of files) {
    const path = `data/${file}`;
    data.set(dataKey({ path, raw: false }), parseDataFile(path, readFileSync(new URL(`../gallery/${path}`, import.meta.url), "utf8")));
  }
  return specToMarkdown(source, data);
}

describe("toMarkdown: Benchmark conditions", () => {
  it("says a row is not comparable instead of judging it, with what differs", () => {
    expect(
      markdown(`Benchmark([
        {name: "Presented FPS", before: 112.583, after: 114.88, unit: "fps", better: "higher", context: {device: "iPhone", thermal: "Nominal"}},
        {name: "Delivered FPS", before: 45.464, after: 48.849, unit: "fps", better: "higher", varies: "archive", context: {device: "iPhone"}, contextBefore: {archive: "off", thermal: "Serious"}, contextAfter: {archive: "on", thermal: "Fair"}},
        {name: "Render FPS", before: [58.19, 58.04], after: [70.13, 67.9], unit: "fps", better: "higher", contextBefore: {device: "iPhone", display: "60 Hz"}, contextAfter: {device: "iPhone"}}
      ])`),
    ).toBe(
      [
        "**Benchmark** · 2 faster · 1 not comparable (conditions differ) · 9.2% faster overall (geometric mean)",
        "Same conditions for every row: device iPhone",
        [
          "|  | Before | After | Change | Conditions |",
          "| --- | --- | --- | --- | --- |",
          "| Presented FPS (higher is better) | 113 fps | 115 fps | 🟢 +2.0% (+2.3 fps) | thermal Nominal |",
          "| Delivered FPS (higher is better) | 45.5 fps | 48.8 fps | ⚠️ not comparable · measured +7.4% (+3.38 fps) | thermal differs: Serious before, Fair after · archive off → on (varied on purpose) |",
          "| Render FPS (higher is better) | 58.1 fps (mean of 2) | 69 fps (mean of 2) | 🟢 +18.8% (+10.9 fps) | display 60 Hz (before only) |",
        ].join("\n"),
      ].join("\n\n"),
    );
  });
});

describe("toMarkdown: Benchmark all runs", () => {
  it("is a table per group with the best per metric starred and failed runs kept", () => {
    const text = markdown('Benchmark(Load("data/device-runs.json"))', "device-runs.json");
    const parts = text.split("\n\n");
    expect(parts[0]).toBe("**Benchmark** · 20 runs · 19 measured · 1 failed · conditions differ: workload, FPS measure, display, thermal");
    expect(parts[1]).toBe("Same conditions for every run: device iPhone");
    expect(parts[2]).toBe("**workload: Rust replay** · 2 runs");
    expect(parts[3]).toBe(
      [
        "| Run | FPS ↑ | p95 frame time ↓ | p99 frame interval ↓ | Peak footprint ↓ | Note |",
        "| --- | --- | --- | --- | --- | --- |",
        "| Before memory work | 24 fps | 51.83 ms | — | — |  |",
        "| Probe-free Release build | **59.8 fps** ★ | **17.44 ms** ★ | — | — | Same replay ticks as the run before |",
      ].join("\n"),
    );
    expect(text).toContain("| Relaunch after the live match | failed | failed | failed | failed | Stopped during GPU warm-up; no crash or Jetsam report found |");
    expect(text).toContain("| Binary archive off | 45.46 fps | — | 41.67 ms | **3.778 GB** ★ | thermal Serious | Stable 120 Hz gate failed |");
    expect(parts.at(-1)).toBe("↑ higher is better · ↓ lower is better · ★ best of the measured runs per workload, among runs whose conditions differ");
  });

  it("is one table without a grouping, with the status words the runs gave", () => {
    expect(
      markdown(`Benchmark([
        {name: "Archive off", metrics: {fps: 45.464, p99_ms: 41.675}, context: {thermal: "Serious"}},
        {name: "Archive on", metrics: {fps: 48.849, p99_ms: 41.675}, context: {thermal: "Serious"}},
        {name: "Relaunch", status: "crashed", metrics: {}, context: {thermal: "Serious"}}
      ])`),
    ).toBe(
      [
        "**Benchmark** · 3 runs · 2 measured · 1 crashed",
        "Same conditions for every run: thermal Serious",
        [
          "| Run | FPS ↑ | p99 ↓ |",
          "| --- | --- | --- |",
          "| Archive off | 45.46 fps | 41.67 ms |",
          "| Archive on | **48.85 fps** ★ | 41.67 ms |",
          "| Relaunch | crashed | crashed |",
        ].join("\n"),
        "↑ higher is better · ↓ lower is better · ★ best of the measured runs",
      ].join("\n\n"),
    );
  });

  it("says so when there are no runs", () => {
    expect(markdown("Benchmark({runs: []})")).toBe("**Benchmark** · no runs");
  });
});
