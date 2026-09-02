#!/usr/bin/env bun
import type { WorkspacePlugin } from "./plugin-package.ts";
import { workspacePlugins } from "./plugin-package.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type BuildPlugin = (plugin: WorkspacePlugin) => Promise<number>;

export async function buildManagedPlugins(
  buildPlugin: BuildPlugin = runPluginBuild,
  plugins: readonly WorkspacePlugin[] = workspacePlugins(ROOT),
): Promise<void> {
  for (const plugin of plugins) {
    const exitCode = await buildPlugin(plugin);
    if (exitCode !== 0) {
      throw new Error(`${plugin.name} build exited with status ${exitCode}`);
    }
  }
}

async function runPluginBuild(plugin: WorkspacePlugin): Promise<number> {
  const child = Bun.spawn(["bun", "run", "build"], {
    cwd: plugin.dir,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

if (import.meta.main) {
  await buildManagedPlugins();
}
