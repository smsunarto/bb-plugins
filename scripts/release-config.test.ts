import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { releaseTargets } from "./release";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

test("Release Please covers every publishable release target with the existing tag contract", () => {
  const config = JSON.parse(
    readFileSync(`${ROOT}/release-please-config.json`, "utf8"),
  ) as ReleasePleaseConfig;
  const manifest = JSON.parse(
    readFileSync(`${ROOT}/.release-please-manifest.json`, "utf8"),
  ) as Record<string, unknown>;
  const targets = releaseTargets(ROOT);
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
    expect(manifest[target.relativePath]).toBe(target.manifest.version);
  }
});
