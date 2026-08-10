#!/usr/bin/env bun
/**
 * Reload the workspace plugins that are installed (as path sources from this
 * repo) and enabled in the running bb. Used by `bun run build:reload` after a
 * successful build; never wired into the plain build so builds keep working
 * in CI and without a bb server.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const bb = process.env.BB_CLI ?? "bb";

const workspaceIds = new Set<string>();
for (const entry of readdirSync(join(ROOT, "plugins"))) {
  const manifestPath = join(ROOT, "plugins", entry, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest.name === "string" && manifest.name.startsWith("bb-plugin-")) {
    workspaceIds.add(manifest.name.slice("bb-plugin-".length));
  }
}

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
    p.rootDir?.startsWith(join(ROOT, "plugins")),
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
