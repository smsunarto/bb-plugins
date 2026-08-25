import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  independentPackageReleases,
  withOnlyPackageChangesets,
  type ChangesetStatus,
} from "./package-release";
import type { WorkspacePlugin } from "./plugin-package";

function plugin(id: string, version: string): WorkspacePlugin {
  return {
    directory: id,
    dir: `/repo/plugins/${id}`,
    id,
    name: `@smsunarto/bb-plugin-${id}`,
    manifest: {
      name: `@smsunarto/bb-plugin-${id}`,
      version,
      bb: { name: id.toUpperCase() },
    },
  };
}

const status: ChangesetStatus = {
  changesets: [
    {
      id: "beta-fix",
      summary: "Fix beta.",
      releases: [{ name: "@smsunarto/bb-plugin-beta", type: "minor" }],
    },
    {
      id: "alpha-fix",
      summary: "Fix alpha.",
      releases: [{ name: "@smsunarto/bb-plugin-alpha", type: "patch" }],
    },
  ],
  releases: [
    {
      name: "@smsunarto/bb-plugin-beta",
      type: "minor",
      oldVersion: "2.0.0",
      newVersion: "2.1.0",
      changesets: ["beta-fix"],
    },
    {
      name: "@smsunarto/bb-plugin-alpha",
      type: "patch",
      oldVersion: "1.0.0",
      newVersion: "1.0.1",
      changesets: ["alpha-fix"],
    },
  ],
};

describe("independent package release planning", () => {
  test("returns one sorted release unit per package", () => {
    expect(
      independentPackageReleases(status, [plugin("alpha", "1.0.0"), plugin("beta", "2.0.0")]),
    ).toEqual([
      {
        id: "alpha",
        name: "@smsunarto/bb-plugin-alpha",
        displayName: "ALPHA",
        oldVersion: "1.0.0",
        newVersion: "1.0.1",
        changesets: ["alpha-fix"],
      },
      {
        id: "beta",
        name: "@smsunarto/bb-plugin-beta",
        displayName: "BETA",
        oldVersion: "2.0.0",
        newVersion: "2.1.0",
        changesets: ["beta-fix"],
      },
    ]);
  });

  test("rejects a changeset that targets several packages", () => {
    const shared: ChangesetStatus = {
      changesets: [
        {
          id: "shared",
          summary: "Shared change.",
          releases: [
            { name: "@smsunarto/bb-plugin-alpha", type: "patch" },
            { name: "@smsunarto/bb-plugin-beta", type: "patch" },
          ],
        },
      ],
      releases: [],
    };
    expect(() =>
      independentPackageReleases(shared, [plugin("alpha", "1.0.0"), plugin("beta", "2.0.0")]),
    ).toThrow("Each changeset must target exactly one package");
  });

  test("rejects dependent bumps without a direct package changeset", () => {
    const dependent: ChangesetStatus = structuredClone(status);
    dependent.releases.push({
      name: "@smsunarto/bb-plugin-gamma",
      type: "patch",
      oldVersion: "3.0.0",
      newVersion: "3.0.1",
      changesets: [],
    });
    expect(() =>
      independentPackageReleases(dependent, [
        plugin("alpha", "1.0.0"),
        plugin("beta", "2.0.0"),
        plugin("gamma", "3.0.0"),
      ]),
    ).toThrow("Dependent package bumps cannot use independent release PRs");
  });
});

test("changeset isolation restores every other package changeset", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-package-release-test-"));
  const directory = join(root, ".changeset");
  mkdirSync(directory);
  writeFileSync(join(directory, "alpha-fix.md"), "alpha\n");
  writeFileSync(join(directory, "beta-fix.md"), "beta\n");

  try {
    withOnlyPackageChangesets(root, status, new Set(["alpha-fix"]), () => {
      expect(existsSync(join(directory, "alpha-fix.md"))).toBe(true);
      expect(existsSync(join(directory, "beta-fix.md"))).toBe(false);
      writeFileSync(join(directory, "alpha-fix.md"), "consumed\n");
    });
    expect(readFileSync(join(directory, "alpha-fix.md"), "utf8")).toBe("consumed\n");
    expect(readFileSync(join(directory, "beta-fix.md"), "utf8")).toBe("beta\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changeset isolation restores other changesets after a failure", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-package-release-test-"));
  const directory = join(root, ".changeset");
  mkdirSync(directory);
  writeFileSync(join(directory, "alpha-fix.md"), "alpha\n");
  writeFileSync(join(directory, "beta-fix.md"), "beta\n");

  try {
    expect(() =>
      withOnlyPackageChangesets(root, status, new Set(["alpha-fix"]), () => {
        throw new Error("version failed");
      }),
    ).toThrow("version failed");
    expect(readFileSync(join(directory, "beta-fix.md"), "utf8")).toBe("beta\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
