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
    if (parent === dir) throw new Error("pool-bar: plugin root not found");
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
 * PoolBar.swift rebuilds it. Compiling here rather than in `bb plugin build` keeps
 * the plugin installable from a path or Git source with only the Xcode command
 * line tools, which `swiftc` needs either way.
 */
export async function buildHelper(signal: AbortSignal): Promise<string> {
  const source = join(nativeDir(), "PoolBar.swift");
  const hash = createHash("sha256")
    .update(await readFile(source))
    .update(process.arch)
    .digest("hex")
    .slice(0, 16);
  const dir = join(homedir(), "Library", "Caches", "bb-pool-bar", hash);
  const binary = join(dir, "PoolBar");
  if (existsSync(binary)) return binary;

  await mkdir(dir, { recursive: true });
  const partial = `${binary}.${process.pid}.partial`;
  try {
    await run("swiftc", ["-O", "-parse-as-library", "-o", partial, source], {
      signal,
      maxBuffer: 8 * 1024 * 1024,
    });
    await rename(partial, binary);
  } catch (error) {
    await rm(partial, { force: true });
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`pool-bar: swiftc failed${stderr ? `:\n${stderr}` : ""}`, { cause: error });
  }
  return binary;
}
