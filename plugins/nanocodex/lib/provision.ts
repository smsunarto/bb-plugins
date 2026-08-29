/**
 * `lib/provision.ts` — where nanocodex is, resolved without the SDK.
 *
 * A leaf on purpose: `server.ts` is loaded from source for a path-installed
 * plugin and its runtime shim cannot resolve `@get-bb/plugin-sdk` subpaths, so
 * everything the registration reaches must stay off them. That rules out
 * `experimental_resolveExecutablePath`, which is a provider-bridge export, so
 * the search is hand-rolled here — and then SHARED with the bridge's
 * maintenance probe, so a plugin that registered against one binary can never
 * spawn a different one.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Search order:
 *   1. `NANOCODEX_CLI_PATH`, if it names an executable file.
 *   2. `nanocodex` on PATH.
 *   3. `~/.local/share/nanocodex/bin/nanocodex`, the installer's location.
 *   4. `~/.local/bin/nanocodex`.
 *
 * Step 3 exists because a GUI-launched daemon has a minimal PATH: without it,
 * a correctly installed nanocodex is invisible to bb exactly when the user
 * launched bb from the Dock.
 *
 * Returns null when nothing is executable. The registration turns that into
 * `bb.status.needsConfiguration`, never a load failure.
 */
export function resolveNanocodexCli(env: NodeJS.ProcessEnv): string | null {
  const configured = env.NANOCODEX_CLI_PATH?.trim();
  if (configured !== undefined && configured.length > 0 && isExecutableFile(configured)) {
    return configured;
  }
  const home = homedir();
  const directories = [
    ...(env.PATH ?? "").split(delimiter).filter((directory) => directory.length > 0),
    join(home, ".local", "share", "nanocodex", "bin"),
    join(home, ".local", "bin"),
  ];
  for (const directory of new Set(directories)) {
    const candidate = join(directory, "nanocodex");
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** `nanocodex --version` -> `x.y.z`, or null. Used by `bb nanocodex status`; the bridge uses the SDK's probe. */
export function readNanocodexVersion(command: string): string | null {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.error !== undefined || result.status !== 0) return null;
  const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(`${result.stdout}\n${result.stderr}`);
  return match === null ? null : match[0];
}
