import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// The server runs from src/ under `bb plugin dev` and from dist/ once built,
// so resolve the plugin root instead of hardcoding a relative path.
function pluginRoot(): string {
  let dir = import.meta.dirname;
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("usage-bar: plugin root not found");
    dir = parent;
  }
  return dir;
}

/** The native sources and the brand marks the helper loads at runtime. */
export function nativeDir(): string {
  return join(pluginRoot(), "native");
}

/**
 * Compile the AppKit helper once per source revision. The binary is cached by the
 * source hash under ~/Library/Caches, so a plugin reload reuses it and an edit to
 * UsageBar.swift rebuilds it. Compiling here rather than in `bb plugin build` keeps
 * the plugin installable from a path or Git source with only the Xcode command
 * line tools, which `swiftc` needs either way. Missing tools or a failed compile
 * throw NeedsConfigurationError, which bb matches by name to stop restarting the
 * service until the plugin is reloaded.
 */
export async function buildHelper(signal: AbortSignal): Promise<string> {
  const source = join(nativeDir(), "UsageBar.swift");
  const args = ["-O", "-parse-as-library", "-swift-version", "5"] as const;
  const hash = createHash("sha256")
    .update(await readFile(source))
    .update(process.arch)
    .update(args.join("\0"))
    .digest("hex")
    .slice(0, 16);
  const dir = join(homedir(), "Library", "Caches", "bb-usage-bar", hash);
  const binary = join(dir, "UsageBar");
  if (existsSync(binary)) return binary;

  try {
    await run("xcode-select", ["-p"], { signal });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw Object.assign(
      new Error(
        "Usage Bar needs the Xcode command line tools. Run xcode-select --install, then reload the plugin.",
      ),
      { name: "NeedsConfigurationError", cause },
    );
  }

  await mkdir(dir, { recursive: true });
  const partial = `${binary}.${process.pid}.partial`;
  try {
    await run("swiftc", [...args, "-o", partial, source], {
      signal,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    await rm(partial, { force: true });
    if (signal.aborted) throw error;
    const failure = error as { code?: unknown; signal?: unknown; stderr?: string };
    const stderr = failure.stderr?.trim();
    // Only swiftc exiting with a status is a compile failure. A killed compiler or a
    // spawn error may be transient, so bb restarts the service with backoff.
    if (typeof failure.code !== "number" || failure.signal) {
      throw new Error(`usage-bar: swiftc failed${stderr ? `:\n${stderr}` : ""}`, { cause: error });
    }
    // The first lines usually name the problem. The full output stays on `cause`.
    const head = stderr ? `\n${stderr.split("\n").slice(0, 4).join("\n")}` : "";
    throw Object.assign(
      new Error(
        `Usage Bar could not compile its menu bar helper. Update the Xcode command line tools (xcode-select --install), then reload the plugin.${head}`,
      ),
      { name: "NeedsConfigurationError", cause: error },
    );
  }
  await rename(partial, binary);
  return binary;
}
