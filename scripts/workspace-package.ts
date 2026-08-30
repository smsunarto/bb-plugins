import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface PackageManifest {
  name: string;
  version?: string;
  description?: string;
  license?: string;
  private?: boolean;
  author?: unknown;
  repository?: unknown;
  publishConfig?: { access?: string };
  files?: unknown;
  bin?: unknown;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface WorkspacePackage {
  /** Directory name under packages/. */
  directory: string;
  /** Absolute path to the package root. */
  dir: string;
  name: string;
  manifest: PackageManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`package.json ${field} must be a string`);
  return value;
}

function optionalDependencyMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`package.json ${field} must be an object`);
  const dependencies: Record<string, string> = {};
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec !== "string") {
      throw new Error(`package.json ${field}.${name} must be a string`);
    }
    dependencies[name] = spec;
  }
  return dependencies;
}

function parsePackageManifest(value: unknown): PackageManifest {
  if (!isRecord(value)) throw new Error("package.json must contain an object");
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw new Error("package.json name must be a non-empty string");
  }
  if (value.private !== undefined && typeof value.private !== "boolean") {
    throw new Error("package.json private must be a boolean");
  }

  let publishConfig: PackageManifest["publishConfig"];
  if (value.publishConfig !== undefined) {
    if (!isRecord(value.publishConfig)) {
      throw new Error("package.json publishConfig must be an object");
    }
    publishConfig = {
      access: optionalString(value.publishConfig.access, "publishConfig.access"),
    };
  }

  return {
    name: value.name,
    version: optionalString(value.version, "version"),
    description: optionalString(value.description, "description"),
    license: optionalString(value.license, "license"),
    private: value.private,
    author: value.author,
    repository: value.repository,
    publishConfig,
    files: value.files,
    bin: value.bin,
    exports: value.exports,
    dependencies: optionalDependencyMap(value.dependencies, "dependencies"),
    peerDependencies: optionalDependencyMap(value.peerDependencies, "peerDependencies"),
    optionalDependencies: optionalDependencyMap(value.optionalDependencies, "optionalDependencies"),
  };
}

/** Every npm package under packages/, sorted by directory name. */
export function workspacePackages(root: string): WorkspacePackage[] {
  const packagesDir = join(root, "packages");
  const packages: WorkspacePackage[] = [];
  for (const directory of readdirSync(packagesDir).sort()) {
    const dir = join(packagesDir, directory);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const rawManifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    const manifest = parsePackageManifest(rawManifest);
    packages.push({ directory, dir, name: manifest.name, manifest });
  }
  return packages;
}

export function publishableWorkspacePackages(root: string): WorkspacePackage[] {
  return workspacePackages(root).filter((candidate) => candidate.manifest.private !== true);
}
