#!/usr/bin/env bun
/**
 * Reload the workspace plugins that are installed (as path sources from this
 * repo) and enabled in the running bb. Used by `bun run build:reload` after a
 * successful build; never wired into the plain build so builds keep working
 * in CI and without a bb server.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { workspacePlugins } from "./plugin-package";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const bb = process.env.BB_CLI ?? "bb";

/** Symlink-resolved absolute path, falling back to a plain resolve. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// `rootDir` is whatever path bb recorded at install time, so both sides need
// the same normalization before they can be compared.
const PLUGINS_DIR = canonical(join(ROOT, "plugins"));

function isWorkspacePluginDir(rootDir: string | undefined): boolean {
  if (!rootDir) return false;
  const relativePath = relative(PLUGINS_DIR, canonical(rootDir));
  // Reject "" (the plugins dir itself), escapes, and siblings like "plugins-old".
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

// `bb plugin list` reports the id bb derived from each package name, so the
// workspace side has to derive it the same way.
const workspaceIds = new Set(workspacePlugins(ROOT).map((plugin) => plugin.id));

interface InstalledPlugin {
  id: string;
  enabled: boolean;
  source?: string;
  rootDir?: string;
}

let installed: InstalledPlugin[];
try {
  const out = execFileSync(bb, ["plugin", "list", "--json"], { encoding: "utf8" });
  installed = JSON.parse(out).plugins ?? [];
} catch {
  console.error("could not reach bb (`bb plugin list --json` failed) — is the app running?");
  process.exit(1);
}

const targets = installed.filter(
  (p) =>
    p.enabled &&
    workspaceIds.has(p.id) &&
    p.source?.startsWith("path:") &&
    isWorkspacePluginDir(p.rootDir),
);

if (targets.length === 0) {
  console.log("no enabled workspace plugins are installed in bb — nothing to reload");
  process.exit(0);
}

let failures = 0;
for (const plugin of targets) {
  try {
    execFileSync(bb, ["plugin", "reload", plugin.id], { stdio: "pipe" });
    console.log(`reloaded ${plugin.id}`);
  } catch (error) {
    failures++;
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.error(`failed to reload ${plugin.id}: ${detail}`);
  }
}
process.exit(failures > 0 ? 1 : 0);
