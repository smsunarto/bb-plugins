import { experimental_execHostFile as run } from "@get-bb/plugin-sdk/process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import antigravityMark from "../../native/antigravity.svg" with { type: "text" };
import claudeMark from "../../native/claude.svg" with { type: "text" };
import codexMark from "../../native/codex.svg" with { type: "text" };
import swiftSource from "../../native/UsageBar.swift" with { type: "text" };

/**
 * bb ships the host entry to each machine as one bundled file, so the helper's
 * sources and the brand marks it loads at runtime are embedded here and written
 * next to the binary.
 */
const NATIVE_FILES = {
  "UsageBar.swift": swiftSource,
  "antigravity.svg": antigravityMark,
  "claude.svg": claudeMark,
  "codex.svg": codexMark,
};

/**
 * A compile that runs longer than this is killed and treated as a transient
 * failure, so a wedged `swiftc` cannot hold the worker forever.
 */
const SWIFTC_TIMEOUT_MS = 5 * 60_000;

/**
 * Compile the AppKit helper once per source revision. The binary is cached by the
 * source hash under ~/Library/Caches, so a plugin reload reuses it and an edit to
 * UsageBar.swift rebuilds it. Compiling on the Mac rather than in `bb plugin build`
 * keeps the plugin installable from a path or Git source with only the Xcode
 * command line tools, which `swiftc` needs either way. Missing tools or a failed
 * compile throw NeedsConfigurationError: retrying cannot fix either.
 *
 * Each build stages its inputs and output in its own temporary directory, so two
 * workers building at once never write the same file. The brand marks move into
 * place before the binary, so an existing binary means a complete directory.
 *
 * Returns the binary and its directory, which holds the brand marks.
 */
export async function buildHelper(
  signal: AbortSignal,
  options: { swiftcTimeoutMs?: number } = {},
): Promise<{ binary: string; dir: string }> {
  const args = ["-O", "-parse-as-library", "-swift-version", "5"] as const;
  const hash = createHash("sha256")
    .update(JSON.stringify(NATIVE_FILES))
    .update(process.arch)
    .update(args.join("\0"))
    .digest("hex")
    .slice(0, 16);
  const cache = join(homedir(), "Library", "Caches", "bb-usage-bar");
  const dir = join(cache, hash);
  const binary = join(dir, "UsageBar");
  if (existsSync(binary)) return { binary, dir };

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

  await mkdir(cache, { recursive: true });
  // Staged beside `dir` so each rename stays on one filesystem.
  const stage = await mkdtemp(join(cache, `.${hash}-build-`));
  try {
    for (const [name, text] of Object.entries(NATIVE_FILES))
      await writeFile(join(stage, name), text);
    const staged = join(stage, "UsageBar");
    try {
      await run("swiftc", [...args, "-o", staged, join(stage, "UsageBar.swift")], {
        signal,
        timeout: options.swiftcTimeoutMs ?? SWIFTC_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const failure = error as { code?: unknown; signal?: unknown; stderr?: string };
      const stderr = failure.stderr?.trim();
      // Only swiftc exiting with a status is a compile failure. A killed or timed-out
      // compiler or a spawn error may be transient, so the host retries it.
      if (typeof failure.code !== "number" || failure.signal) {
        throw new Error(`usage-bar: swiftc failed${stderr ? `:\n${stderr}` : ""}`, {
          cause: error,
        });
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
    await mkdir(dir, { recursive: true });
    // Every build writes identical files, so a concurrent build's renames are harmless.
    for (const name of Object.keys(NATIVE_FILES)) await rename(join(stage, name), join(dir, name));
    await rename(staged, binary);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { binary, dir };
}
