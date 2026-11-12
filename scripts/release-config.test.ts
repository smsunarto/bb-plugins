import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  marketplacePluginIds,
  npmPublishPaths,
  publishableWorkspacePlugins,
  tagOnlyWorkspacePlugins,
  workspacePlugins,
} from "./plugin-package";
import { publishableWorkspacePackages } from "./workspace-package";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Kept out of Release Please, though the marketplace lists them. */
const NOT_RELEASED = new Set([
  // Excluded on purpose (270bf3f7).
  "plugins/traces",
  // Listed in the marketplace without a release tag today.
  "plugins/vimium",
  "plugins/whiteboard",
]);

interface PackageConfig {
  "release-type"?: unknown;
  component?: unknown;
  "package-name"?: unknown;
}

interface ReleasePleaseConfig {
  "bootstrap-sha"?: unknown;
  "separate-pull-requests"?: unknown;
  "include-component-in-tag"?: unknown;
  "include-v-in-tag"?: unknown;
  "tag-separator"?: unknown;
  packages?: Record<string, PackageConfig>;
}

test("Release Please covers enabled publishable targets with the existing tag contract", () => {
  const config = JSON.parse(
    readFileSync(`${ROOT}/.github/release-please-config.json`, "utf8"),
  ) as ReleasePleaseConfig;
  const manifest = JSON.parse(
    readFileSync(`${ROOT}/.github/.release-please-manifest.json`, "utf8"),
  ) as Record<string, unknown>;
  const targets = [
    ...publishableWorkspacePackages(ROOT).map((candidate) => ({
      relativePath: `packages/${candidate.directory}`,
      component: candidate.directory,
      name: candidate.name,
      version: candidate.manifest.version,
    })),
    // Release targets: publishable packages, plus private plugins the marketplace
    // lists, which are released as tags only.
    ...[...publishableWorkspacePlugins(ROOT), ...tagOnlyWorkspacePlugins(ROOT)].map((plugin) => ({
      relativePath: `plugins/${plugin.directory}`,
      component: plugin.id,
      name: plugin.name,
      version: plugin.manifest.version,
    })),
  ].filter((target) => !NOT_RELEASED.has(target.relativePath));
  const expectedPaths = targets.map((target) => target.relativePath).sort();

  expect(config["bootstrap-sha"]).toBe("da91c8346edea3232888503164125ca39eed5486");
  expect(config["separate-pull-requests"]).toBe(true);
  expect(config["include-component-in-tag"]).toBe(true);
  expect(config["include-v-in-tag"]).toBe(true);
  expect(config["tag-separator"]).toBe("/");
  expect(Object.keys(config.packages ?? {}).sort()).toEqual(expectedPaths);
  expect(Object.keys(manifest).sort()).toEqual(expectedPaths);

  for (const target of targets) {
    expect(config.packages?.[target.relativePath]).toEqual({
      "release-type": "node",
      component: target.component,
      "package-name": target.name,
    });
    expect(manifest[target.relativePath]).toBe(target.version);
  }
});

function releasePaths(): string[] {
  const config = JSON.parse(
    readFileSync(`${ROOT}/.github/release-please-config.json`, "utf8"),
  ) as ReleasePleaseConfig;
  return Object.keys(config.packages ?? {});
}

test("every marketplace plugin has a release entry whose tags it resolves", () => {
  const config = JSON.parse(
    readFileSync(`${ROOT}/.github/release-please-config.json`, "utf8"),
  ) as ReleasePleaseConfig;
  const marketplace = JSON.parse(readFileSync(`${ROOT}/marketplace.json`, "utf8")) as {
    plugins: { id: string; source: { git?: { subdir?: string; tagPrefix?: string } } }[];
  };
  const byId = new Map(workspacePlugins(ROOT).map((plugin) => [plugin.id, plugin]));
  for (const entry of marketplace.plugins) {
    const git = entry.source.git;
    if (!git?.tagPrefix || !byId.has(entry.id)) continue;
    const path = git.subdir ?? `plugins/${byId.get(entry.id)!.directory}`;
    if (NOT_RELEASED.has(path)) continue;
    const release = config.packages?.[path];
    expect(release, `${entry.id} has no Release Please entry`).toBeDefined();
    // include-v-in-tag and tag-separator "/" make tags `<component>/vX.Y.Z`.
    expect(`${String(release?.component)}/`).toBe(git.tagPrefix);
  }
  expect(marketplacePluginIds(ROOT).size).toBeGreaterThan(0);
});

test("no private package reaches npm publish", () => {
  const released = releasePaths();
  const published = npmPublishPaths(ROOT, released);
  for (const plugin of workspacePlugins(ROOT).filter((each) => each.manifest.private === true))
    expect(published).not.toContain(`plugins/${plugin.directory}`);
  // Tag-only plugins are released but filtered out before npm.
  for (const plugin of tagOnlyWorkspacePlugins(ROOT)) {
    if (NOT_RELEASED.has(`plugins/${plugin.directory}`)) continue;
    expect(released).toContain(`plugins/${plugin.directory}`);
    expect(published).not.toContain(`plugins/${plugin.directory}`);
  }

  const workflow = readFileSync(`${ROOT}/.github/workflows/release.yaml`, "utf8");
  // The automatic publish matrix comes from the filtered list, never the raw released paths.
  expect(workflow).toContain("fromJSON(needs.release-please.outputs.npm_paths)");
  expect(workflow).not.toContain("fromJSON(needs.release-please.outputs.paths_released)");
  expect(workflow).toContain("bun scripts/release-npm-paths.ts");
  // A manual publish can name only a publishable package.
  const options = [...workflow.matchAll(/^ {10}- (\S+)$/gm)].map((match) => match[1]!);
  expect(options.length).toBeGreaterThan(0);
  expect(npmPublishPaths(ROOT, options)).toEqual(options);
});
