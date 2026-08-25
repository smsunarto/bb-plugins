#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspacePlugin } from "./plugin-package";
import { publishableWorkspacePlugins } from "./publish";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface ChangesetStatus {
  changesets: {
    id: string;
    summary: string;
    releases: { name: string; type: string }[];
  }[];
  releases: {
    name: string;
    type: string;
    oldVersion: string;
    newVersion: string;
    changesets: string[];
  }[];
}

export interface PackageRelease {
  id: string;
  name: string;
  displayName: string;
  oldVersion: string;
  newVersion: string;
  changesets: string[];
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

/** Build one independent release unit for each package in the Changesets plan. */
export function independentPackageReleases(
  status: ChangesetStatus,
  plugins: readonly WorkspacePlugin[],
): PackageRelease[] {
  const pluginsByName = new Map(plugins.map((plugin) => [plugin.name, plugin]));
  const changesetsByPackage = new Map<string, string[]>();

  for (const changeset of status.changesets) {
    if (changeset.releases.length !== 1) {
      throw new Error(
        `changeset ${changeset.id} targets ${changeset.releases.length} packages. Each changeset must target exactly one package`,
      );
    }
    const packageName = changeset.releases[0].name;
    if (!pluginsByName.has(packageName)) {
      throw new Error(`changeset ${changeset.id} targets non-publishable package ${packageName}`);
    }
    const packageChangesets = changesetsByPackage.get(packageName) ?? [];
    packageChangesets.push(changeset.id);
    changesetsByPackage.set(packageName, packageChangesets);
  }

  const releases = status.releases.map((release): PackageRelease => {
    const plugin = pluginsByName.get(release.name);
    if (!plugin) {
      throw new Error(`release plan contains non-publishable package ${release.name}`);
    }
    const directChangesets = changesetsByPackage.get(release.name) ?? [];
    if (directChangesets.length === 0) {
      throw new Error(
        `release plan updates ${release.name} without a direct changeset. Dependent package bumps cannot use independent release PRs`,
      );
    }
    if (!sameMembers(directChangesets, release.changesets)) {
      throw new Error(`release plan has inconsistent changesets for ${release.name}`);
    }
    if (plugin.manifest.version !== release.oldVersion) {
      throw new Error(
        `${release.name} manifest is ${plugin.manifest.version}, but the release plan starts at ${release.oldVersion}`,
      );
    }
    return {
      id: plugin.id,
      name: plugin.name,
      displayName: plugin.manifest.bb?.name ?? plugin.id,
      oldVersion: release.oldVersion,
      newVersion: release.newVersion,
      changesets: [...release.changesets].sort(),
    };
  });

  if (releases.length !== changesetsByPackage.size) {
    throw new Error("the Changesets plan does not contain one release for each changed package");
  }
  return releases.sort((left, right) => left.id.localeCompare(right.id));
}

export function withOnlyPackageChangesets<T>(
  root: string,
  status: ChangesetStatus,
  keptChangesets: ReadonlySet<string>,
  operation: () => T,
): T {
  const removed = new Map<string, Buffer>();
  for (const changeset of status.changesets) {
    if (keptChangesets.has(changeset.id)) continue;
    const path = join(root, ".changeset", `${changeset.id}.md`);
    removed.set(path, readFileSync(path));
    unlinkSync(path);
  }

  try {
    return operation();
  } finally {
    for (const [path, contents] of removed) writeFileSync(path, contents);
  }
}

function readChangesetStatus(root: string): ChangesetStatus {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "bb-package-release-"));
  const output = join(temporaryDirectory, "status.json");
  try {
    execFileSync("bun", ["run", "changeset", "status", `--output=${output}`], {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
    });
    return JSON.parse(readFileSync(output, "utf8")) as ChangesetStatus;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function validateOutputValue(label: string, value: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} must fit on one line`);
  }
  return value;
}

function writeOutputs(outputs: Record<string, string>): void {
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (!githubOutput) {
    console.log(JSON.stringify(outputs));
    return;
  }
  for (const [name, rawValue] of Object.entries(outputs)) {
    const value = validateOutputValue(name, rawValue);
    appendFileSync(githubOutput, `${name}=${value}\n`);
  }
}

function changedPaths(root: string): string[] {
  const output = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  return output
    .split("\0")
    .map((entry) => entry.slice(3))
    .filter(Boolean)
    .sort();
}

function assertPackageVersionDiff(root: string, release: PackageRelease): void {
  const allowed = new Set([
    ...release.changesets.map((id) => `.changeset/${id}.md`),
    `plugins/${release.id}/CHANGELOG.md`,
    `plugins/${release.id}/package.json`,
  ]);
  const unexpected = changedPaths(root).filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error(
      `versioning ${release.name} also changed ${unexpected.join(", ")}. One package release PR cannot contain those paths`,
    );
  }
}

function preparePackageRelease(root: string, packageName: string): PackageRelease {
  const status = readChangesetStatus(root);
  const releases = independentPackageReleases(status, publishableWorkspacePlugins(root));
  const release = releases.find((candidate) => candidate.name === packageName);
  if (!release) throw new Error(`${packageName} has no pending release`);

  withOnlyPackageChangesets(root, status, new Set(release.changesets), () => {
    execFileSync("bun", ["run", "changeset", "version"], { cwd: root, stdio: "inherit" });
  });

  const manifestPath = join(root, "plugins", release.id, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
  if (manifest.version !== release.newVersion) {
    throw new Error(
      `${release.name} version is ${String(manifest.version)}, expected ${release.newVersion}`,
    );
  }
  for (const changeset of release.changesets) {
    const path = join(root, ".changeset", `${changeset}.md`);
    if (existsSync(path)) throw new Error(`${relative(root, path)} was not consumed`);
  }
  assertPackageVersionDiff(root, release);
  return release;
}

function main(): void {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || (command !== "plan" && command !== "version")) {
    throw new Error("usage: package-release.ts plan | version <package-name>");
  }

  if (command === "plan") {
    if (argument !== undefined) throw new Error("plan takes no package name");
    const status = readChangesetStatus(ROOT);
    const releases = independentPackageReleases(status, publishableWorkspacePlugins(ROOT));
    writeOutputs({ packages: JSON.stringify(releases) });
    return;
  }

  if (!argument) throw new Error("version requires a package name");
  const release = preparePackageRelease(ROOT, argument);
  writeOutputs({
    branch: `changeset-release/${release.id}`,
    commit_message: `chore(${release.id}): version package`,
    package_name: release.name,
    package_version: release.newVersion,
    pr_title: `Release ${release.displayName} ${release.newVersion}`,
  });
}

if (import.meta.main) main();
