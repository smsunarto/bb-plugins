/**
 * How these scripts turn a workspace directory into the identity bb uses.
 *
 * Every plugin here publishes as `@smsunarto/bb-plugin-<id>`, and bb derives the
 * runtime id — routes, storage, settings, CLI commands — from the package name
 * rather than the directory: it drops the npm scope, strips the `bb-plugin-`
 * prefix, then normalizes the rest (bb `packages/domain/src/plugin-id.ts`).
 * `@smsunarto/bb-plugin-notify` and `bb-plugin-notify` both give `notify`.
 * Anything that names a plugin goes through derivePluginId(), or it addresses
 * plugins by a name bb never uses.
 *
 * The same `bb-plugin-` text also appears in DOM attributes
 * (`data-bb-plugin-root`). Those are not package names and must not be routed
 * through here.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The package name with any npm scope removed: `@scope/x` → `x`. */
export function unscopedPackageName(packageName: string): string {
  return packageName.includes("/") ? (packageName.split("/").at(-1) ?? packageName) : packageName;
}

/** True for `bb-plugin-<id>` and for `@scope/bb-plugin-<id>`. */
export function isPluginPackageName(packageName: unknown): packageName is string {
  return (
    typeof packageName === "string" && unscopedPackageName(packageName).startsWith("bb-plugin-")
  );
}

/** Mirror of bb's derivePluginId(). Keep the two in step. */
export function derivePluginId(packageName: string): string {
  const id = unscopedPackageName(packageName)
    .replace(/^bb-plugin-/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (id.length === 0) {
    throw new Error(`cannot derive a plugin id from package name "${packageName}"`);
  }
  return id;
}

/** The manifest fields these scripts read. Everything else passes through. */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  license?: string;
  private?: boolean;
  author?: unknown;
  repository?: unknown;
  publishConfig?: { access?: string };
  files?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bb?: {
    name?: string;
    server?: string;
    app?: string;
    skills?: string[];
    commands?: string[] | string;
    branding?: {
      icon?: string;
      logo?: { light?: string; dark?: string };
    };
    themes?: { id?: string; css?: string }[];
  };
  [key: string]: unknown;
}

export interface WorkspacePlugin {
  /** Directory name under plugins/. */
  directory: string;
  /** Absolute path to the plugin root. */
  dir: string;
  /** npm package name, e.g. `@smsunarto/bb-plugin-notify`. */
  name: string;
  /** Runtime id bb derives from `name`, e.g. `notify`. */
  id: string;
  manifest: PluginManifest;
}

/**
 * Every plugin package under `<root>/plugins`, sorted by directory name.
 * Directories with no package.json (artifact-only local installs) and packages
 * that are not plugins are skipped.
 */
export function workspacePlugins(root: string): WorkspacePlugin[] {
  const pluginsDir = join(root, "plugins");
  const plugins: WorkspacePlugin[] = [];
  for (const directory of readdirSync(pluginsDir).sort()) {
    const dir = join(pluginsDir, directory);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest;
    if (!isPluginPackageName(manifest.name)) continue;
    plugins.push({
      directory,
      dir,
      name: manifest.name,
      id: derivePluginId(manifest.name),
      manifest,
    });
  }
  return plugins;
}

export function publishableWorkspacePlugins(root: string): WorkspacePlugin[] {
  return workspacePlugins(root).filter((plugin) => plugin.manifest.private !== true);
}
