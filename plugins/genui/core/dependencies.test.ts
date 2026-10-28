import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  fixMessage,
  groupOutdated,
  parseVersion,
  readDependencies,
  safeTarget,
  severityText,
  splitChange,
  updateMessage,
  versionBump,
  type DependencyReport,
} from "./dependencies";
import type { Value } from "./types";

function fixture(name: string): Value {
  return JSON.parse(readFileSync(new URL(`../gallery/data/${name}`, import.meta.url), "utf8")) as Value;
}

function read(value: Value | undefined): DependencyReport {
  const result = readDependencies(value);
  if (!result.ok) throw new Error(result.error);
  return result.report;
}

const byName = (report: DependencyReport, name: string) => report.outdated.find((item) => item.name === name)!;

describe("versions", () => {
  it("parses semver, Python and loose versions; not ranges or tags", () => {
    expect(parseVersion("v1.2.3-beta.1+build.5")).toEqual({ release: [1, 2, 3], pre: "beta.1", post: false });
    expect(parseVersion("2.10")).toEqual({ release: [2, 10], pre: "", post: false });
    expect(parseVersion("1.0rc1")).toEqual({ release: [1, 0], pre: "rc1", post: false });
    expect(parseVersion("2.0.0.post1")).toEqual({ release: [2, 0, 0], pre: "", post: true });
    expect(parseVersion("^1.2.3")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("git+https://github.com/a/b.git")).toBeNull();
  });

  it("names the bump from the first release number that changes", () => {
    expect(versionBump("18.2.0", "19.3.0")).toBe("major");
    expect(versionBump("4.17.15", "4.18.1")).toBe("minor");
    expect(versionBump("1.2.5", "1.2.8")).toBe("patch");
    expect(versionBump("5.0.0-beta.1", "5.0.0-beta.3")).toBe("prerelease");
    expect(versionBump("5.0.0-rc.1", "5.0.0")).toBe("prerelease");
    expect(versionBump("2.0", "2.0.0.post1")).toBe("prerelease");
    expect(versionBump("2.10", "3.20")).toBe("major");
    expect(versionBump("1.2.3.4", "1.2.3.5")).toBe("patch");
    expect(versionBump("1.0.0", "1.0.0")).toBeNull();
    expect(versionBump("1.0.0", "next")).toBeNull();
  });

  it("orders versions the semver way", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.11")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "~1")).toBeNull();
  });

  it("splits a version where it changes, at a field boundary", () => {
    expect(splitChange("4.17.15", "4.18.1")).toEqual(["4.", "18.1"]);
    expect(splitChange("18.2.0", "19.3.0")).toEqual(["", "19.3.0"]);
    expect(splitChange("1.2.5", "1.2.8")).toEqual(["1.2.", "8"]);
    expect(splitChange("5.0.0-beta.1", "5.0.0-beta.3")).toEqual(["5.0.0-beta.", "3"]);
    expect(splitChange("1.2.3", "1.2.30")).toEqual(["1.2.", "30"]);
    expect(splitChange("1.2.3", "1.2.3")).toEqual(["1.2.3", ""]);
  });
});

describe("readDependencies: outdated", () => {
  it("reads npm outdated --json --long: bumps, wanted, dev vs prod, not installed", () => {
    const report = read(fixture("npm-outdated.json"));
    expect(report.source).toBe("npm");
    expect(report.outdated).toHaveLength(18);
    expect(byName(report, "lodash")).toMatchObject({ current: "4.17.15", wanted: "4.18.1", latest: "4.18.1", bump: "minor", type: "prod" });
    expect(byName(report, "@types/node")).toMatchObject({ bump: "major", type: "dev", url: "https://www.npmjs.com/package/@types/node" });
    expect(byName(report, "minimist")).toMatchObject({ bump: "patch" });
    expect(byName(report, "dayjs")).toMatchObject({ current: null, wanted: "1.11.23", bump: null });
    const groups = groupOutdated(report.outdated);
    expect(groups.map((group) => [group.key, group.packages.length])).toEqual([
      ["major", 13],
      ["minor", 3],
      ["patch", 1],
      ["missing", 1],
    ]);
    // A major whose range allows a newer minor updates to that.
    expect(safeTarget(byName(report, "express"))).toBe("4.22.3");
    expect(safeTarget(byName(report, "eslint"))).toBeNull();
    expect(updateMessage(report)).toBe(
      "Update these dependencies to their latest patch and minor versions, then run the tests: " +
        "express 4.17.1 → 4.22.3, lodash 4.17.15 → 4.18.1, minimist 1.2.5 → 1.2.8, prettier 3.0.0 → 3.9.9, react 18.2.0 → 18.3.1, " +
        "react-dom 18.2.0 → 18.3.1, semver 7.5.1 → 7.8.5, typescript 5.4.5 → 5.9.3, vitest 1.6.0 → 1.6.1, zod 3.22.2 → 3.25.76. " +
        "Leave the major updates for now.",
    );
  });

  it("reads pnpm outdated --format json and flags a 0.x minor as breaking", () => {
    const report = read(fixture("pnpm-outdated.json"));
    expect(report.source).toBe("pnpm");
    expect(byName(report, "drizzle-orm")).toMatchObject({ bump: "minor", breaking: true, type: "prod" });
    expect(byName(report, "@biomejs/biome")).toMatchObject({ bump: "major", type: "dev" });
    expect(safeTarget(byName(report, "drizzle-orm"))).toBeNull();
    expect(safeTarget(byName(report, "hono"))).toBe("4.13.13");
  });

  it("reads pip list --outdated --format=json with two-part versions", () => {
    const report = read(fixture("pip-outdated.json"));
    expect(report.source).toBe("pip");
    expect(byName(report, "idna")).toMatchObject({ current: "2.10", latest: "3.20", bump: "major", type: null, url: "https://pypi.org/project/idna/" });
    expect(byName(report, "click")).toMatchObject({ bump: "minor" });
  });

  it("reads npm workspaces' per-dependent lists and a hand-written list", () => {
    const workspaces = read({
      react: [
        { current: "18.2.0", wanted: "18.3.1", latest: "19.0.0", dependent: "web", location: "node_modules/react" },
        { current: "18.2.0", wanted: "18.3.1", latest: "19.0.0", dependent: "docs", location: "node_modules/react" },
      ],
    });
    expect(workspaces.outdated.map((item) => item.dependent)).toEqual(["web", "docs"]);
    const list = read([
      { name: "next", current: "15.0.0-rc.0", latest: "15.0.0", type: "dev", severity: "high", note: "fixes the cache poisoning advisory" },
      { name: "ünïcode-pkg", current: "1.0.0", latest: "1.0.1" },
      { current: "1" },
    ]);
    expect(list.source).toBe("list");
    expect(list.outdated[0]).toMatchObject({ bump: "prerelease", type: "dev", severity: "high", url: null });
    expect(list.severities.high).toBe(1);
    expect(list.vulnerable).toEqual([
      {
        name: "next",
        severity: "high",
        range: null,
        direct: null,
        through: [],
        pulledInBy: [],
        advisories: [{ title: "fixes the cache poisoning advisory", url: null, severity: "high", range: null }],
        fix: { name: "next", version: "15.0.0", major: false },
      },
    ]);
    expect(fixMessage(list)).toBe("Fix the reported vulnerabilities (1 high) in next.");
  });

  it("is empty for an up-to-date project and an error for unusable input", () => {
    expect(read({}).outdated).toEqual([]);
    expect(read([]).outdated).toEqual([]);
    expect(readDependencies([{ version: "1" }])).toEqual({ ok: false, error: "Dependencies items need a name" });
    expect(readDependencies("npm outdated").ok).toBe(false);
  });

  it("marks a latest older than what is installed", () => {
    const report = read([{ name: "vite", current: "7.0.0-beta.2", latest: "6.3.5" }]);
    expect(report.outdated[0]).toMatchObject({ ahead: true, bump: "major" });
    expect(safeTarget(report.outdated[0])).toBeNull();
  });
});

describe("readDependencies: audit", () => {
  it("reads npm audit --json v2: severities, direct or via, fixes and semver-major fixes", () => {
    const report = read(fixture("npm-audit.json"));
    expect(report.auditSource).toBe("npm audit");
    expect(report.severities).toEqual({ critical: 4, high: 9, moderate: 4, low: 3, info: 0 });
    expect(report.scanned).toBe(311);
    expect(report.vulnerable[0]).toMatchObject({ name: "minimist", severity: "critical", direct: true });
    const qs = report.vulnerable.find((item) => item.name === "qs")!;
    expect(qs).toMatchObject({ direct: false, through: [], range: "<=6.15.3", fix: { name: "express", version: "4.22.3", major: false } });
    expect(qs.advisories[0]).toEqual({
      title: "qs vulnerable to Prototype Pollution",
      url: "https://github.com/advisories/GHSA-hrpp-h998-j3pp",
      severity: "high",
      range: ">=6.7.0 <6.7.3",
    });
    expect(report.vulnerable.find((item) => item.name === "vite-node")).toMatchObject({ through: ["vite"], advisories: [] });
    expect(severityText(report.severities)).toBe("4 critical, 9 high, 4 moderate, 3 low");
    expect(fixMessage(report)).toBe(
      "Fix the npm audit vulnerabilities (4 critical, 9 high, 4 moderate, 3 low). These fixes need a major update, so check their breaking changes: uuid 14.0.2.",
    );
  });

  it("reads pnpm audit --json advisories, grouped by package", () => {
    // Records from a real `pnpm audit --json` (pnpm 11), trimmed to the fields read.
    const report = read({
      advisories: {
        "1099462": {
          id: 1099462,
          title: "Zod denial of service vulnerability",
          module_name: "zod",
          vulnerable_versions: "<=3.22.2",
          patched_versions: ">=3.22.3",
          severity: "moderate",
          url: "https://github.com/advisories/GHSA-m95q-7qp3-xv42",
          findings: [{ version: "3.22.2", paths: [".>zod"] }],
        },
        "1102341": {
          id: 1102341,
          title: "esbuild enables any website to send any requests to the development server and read the response",
          module_name: "esbuild",
          vulnerable_versions: "<=0.24.2",
          patched_versions: ">=0.24.3",
          severity: "moderate",
          url: "https://github.com/advisories/GHSA-67mh-4wv8-2f99",
          findings: [{ version: "0.19.12", paths: [".>tsx>esbuild"] }],
        },
        "1109564": {
          id: 1109564,
          title: "Predictable results in nanoid generation when given non-integer values",
          module_name: "nanoid",
          vulnerable_versions: ">=4.0.0 <5.0.9",
          patched_versions: ">=5.0.9",
          severity: "moderate",
          url: "https://github.com/advisories/GHSA-mwcw-c2x4-8c55",
          findings: [{ version: "5.0.1", paths: [".>nanoid"] }],
        },
        "1138810": {
          id: 1138810,
          title: "nanoid: non-secure generators can loop indefinitely with negative size",
          module_name: "nanoid",
          vulnerable_versions: ">=4.0.0 <5.1.16",
          patched_versions: ">=5.1.16",
          severity: "high",
          url: "https://github.com/advisories/GHSA-28wg-ghj8-5hjv",
          findings: [{ version: "5.0.1", paths: [".>nanoid"] }],
        },
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 3, high: 1, critical: 0 }, dependencies: 27, devDependencies: 38, totalDependencies: 65 },
    });
    expect(report.auditSource).toBe("pnpm audit");
    expect(report.vulnerable.map((item) => [item.name, item.severity, item.direct, item.advisories.length])).toEqual([
      ["nanoid", "high", true, 2],
      ["zod", "moderate", true, 1],
      ["esbuild", "moderate", false, 1],
    ]);
    expect(report.vulnerable[2].pulledInBy).toEqual(["tsx"]);
    expect(report.vulnerable[1].fix).toEqual({ name: "zod", version: ">=3.22.3", major: false });
    expect(report.scanned).toBe(65);
  });

  it("combines {outdated, audit} and rejects an audit that isn't one", () => {
    const report = read({ outdated: fixture("npm-outdated.json"), audit: fixture("npm-audit.json") });
    expect(report.source).toBe("npm");
    expect(report.auditSource).toBe("npm audit");
    expect(report.outdated).toHaveLength(18);
    expect(report.vulnerable).toHaveLength(20);
    expect(readDependencies({ outdated: {}, audit: { nope: 1 } }).ok).toBe(false);
  });
});
