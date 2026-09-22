/** Rebuild the shipped frontend with only an installer's dependencies available. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginManifest } from "./plugin-package";

function run(command: string, args: string[], cwd: string): string {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `${command} ${args.join(" ")} failed in ${cwd}\n${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      { cause: error },
    );
  }
}

/**
 * Packing and installing outside the workspace prevents hoisted development
 * dependencies from hiding broken source imports (issue #128). Use bb's real
 * compiler, including its host-provided React and SDK/app runtime shims.
 *
 * Only the frontend is under test: retain the shipped server bundle and omit
 * the host rebuild. This forces the app source rebuild even when its metadata
 * matches bb, just as installation does when the frontend bundle is SDK-stale.
 */
export function rebuildPackedFrontend(pluginDir: string): string {
  const manifest = JSON.parse(
    readFileSync(join(pluginDir, "package.json"), "utf8"),
  ) as PluginManifest;
  if (!manifest.bb?.app) throw new Error(`${manifest.name} has no frontend entry`);
  const scratch = mkdtempSync(join(tmpdir(), "bb-plugin-frontend-"));
  try {
    const tarball = join(scratch, "plugin.tgz");
    run("bun", ["pm", "pack", "--ignore-scripts", "--filename", tarball], pluginDir);
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ private: true }));
    // Install as a consumer, not as the package root. npm still resolves a
    // root's devDependencies under --omit=dev, including workspace: entries.
    run(
      "npm",
      [
        "install",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarball,
      ],
      scratch,
    );
    const installed = join(scratch, "node_modules", manifest.name);
    const installedManifest = JSON.parse(
      readFileSync(join(installed, "package.json"), "utf8"),
    ) as PluginManifest;
    installedManifest.bb = { ...installedManifest.bb, server: "./dist/server.js" };
    delete installedManifest.bb.host;
    writeFileSync(join(installed, "package.json"), JSON.stringify(installedManifest));
    // A stale/prebuilt app must never turn this check into a cache hit.
    rmSync(join(installed, "dist", "app.js"), { force: true });
    rmSync(join(installed, "dist", "app.meta.json"), { force: true });
    run(process.env.BB_CLI ?? "bb", ["plugin", "build", installed], scratch);
    return readFileSync(join(installed, "dist", "app.js"), "utf8");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const selected = process.argv.slice(2);
  if (selected.length === 0) {
    throw new Error("Usage: bun scripts/plugin-frontend-check.ts <plugin-directory> [...]");
  }
  const plugins = selected.map((path) => resolve(path));
  for (const dir of plugins) {
    const bundle = rebuildPackedFrontend(dir);
    console.log(
      `✓ ${dir}: packed frontend rebuilt with production dependencies (${bundle.length} characters)`,
    );
  }
}
