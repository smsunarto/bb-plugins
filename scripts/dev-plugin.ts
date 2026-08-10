#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

interface LockOwner {
  pid: number;
  token: string;
}

export interface InstalledPlugin {
  id: string;
  rootDir?: string;
}

export type PluginFileSnapshot = Map<string, string>;

const POLL_INTERVAL_MS = 500;
const DEBOUNCE_MS = 250;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "__pycache__",
  "dist",
  "node_modules",
  "types",
]);
const execFileAsync = promisify(execFile);

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export async function snapshotPluginFiles(
  pluginDir: string,
): Promise<PluginFileSnapshot> {
  const snapshot: PluginFileSnapshot = new Map();

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await visit(join(directory, entry.name));
        }
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue;

      const absolutePath = join(directory, entry.name);
      try {
        const metadata = await stat(absolutePath, { bigint: true });
        snapshot.set(
          relative(pluginDir, absolutePath),
          `${metadata.mtimeNs}:${metadata.size}`,
        );
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }

  await visit(pluginDir);
  return snapshot;
}

export function changedPluginFiles(
  previous: PluginFileSnapshot,
  next: PluginFileSnapshot,
): string[] {
  const changed = new Set<string>();

  for (const [path, signature] of next) {
    if (previous.get(path) !== signature) changed.add(path);
  }
  for (const path of previous.keys()) {
    if (!next.has(path)) changed.add(path);
  }

  return [...changed].sort();
}

export async function findInstalledPlugin(
  plugins: readonly InstalledPlugin[],
  pluginDir: string,
): Promise<InstalledPlugin | undefined> {
  const localDir = await realpath(pluginDir).catch(() => resolve(pluginDir));
  for (const plugin of plugins) {
    if (!plugin.rootDir) continue;
    const installedDir = await realpath(plugin.rootDir).catch(() =>
      resolve(plugin.rootDir!),
    );
    if (installedDir === localDir) return plugin;
  }
  return undefined;
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  setActiveChild: (child: ChildProcess | null) => void,
): Promise<number> {
  return await new Promise<number>((resolveExit) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit" });
    setActiveChild(child);

    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      setActiveChild(null);
      resolveExit(exitCode);
    };

    child.once("error", (error) => {
      console.error(`could not start ${command}: ${error.message}`);
      finish(1);
    });
    child.once("exit", (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });
}

async function main(): Promise<void> {
  const pluginDir = await realpath(process.cwd());
  const manifest = JSON.parse(
    await readFile(join(pluginDir, "package.json"), "utf8"),
  );
  const pluginName =
    typeof manifest.name === "string" ? manifest.name : basename(pluginDir);
  const pluginId = pluginName.startsWith("bb-plugin-")
    ? pluginName.slice("bb-plugin-".length)
    : pluginName;
  const hasApp = typeof manifest.bb?.app === "string";
  const lockKey = createHash("sha256")
    .update(pluginDir)
    .digest("hex")
    .slice(0, 16);
  const lockDir = join(tmpdir(), "bb-plugin-dev", `${pluginName}-${lockKey}`);
  const ownerPath = join(lockDir, "owner.json");
  const token = randomUUID();

  function isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return errorCode(error) === "EPERM";
    }
  }

  async function readOwner(): Promise<LockOwner | null> {
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8"));
      return typeof owner.pid === "number" && typeof owner.token === "string"
        ? owner
        : null;
    } catch {
      return null;
    }
  }

  async function acquireLock(): Promise<boolean> {
    await mkdir(join(tmpdir(), "bb-plugin-dev"), { recursive: true });

    for (;;) {
      try {
        await mkdir(lockDir);
        await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }));
        return true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;

        let owner = await readOwner();
        if (!owner) {
          // Another process can observe the directory between mkdir and writeFile.
          await delay(50);
          owner = await readOwner();
        }
        if (owner && isRunning(owner.pid)) {
          console.log(
            `${pluginName} dev watcher is already running (pid ${owner.pid})`,
          );
          return false;
        }

        await rm(lockDir, { recursive: true, force: true });
      }
    }
  }

  async function releaseLock(): Promise<void> {
    const owner = await readOwner();
    if (owner?.token === token) {
      await rm(lockDir, { recursive: true, force: true });
    }
  }

  if (!(await acquireLock())) return;

  const bb = process.env.BB_CLI ?? "bb";
  let activeChild: ChildProcess | null = null;
  let stopping = false;
  let resolveStop: () => void = () => {};
  const stopRequested = new Promise<void>((resolvePromise) => {
    resolveStop = resolvePromise;
  });
  const requestStop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    activeChild?.kill(signal);
    resolveStop();
  };
  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));
  process.on("SIGHUP", () => requestStop("SIGHUP"));

  const setActiveChild = (child: ChildProcess | null): void => {
    activeChild = child;
  };

  try {
    let installedPlugins: InstalledPlugin[];
    try {
      const { stdout } = await execFileAsync(
        bb,
        ["plugin", "list", "--json"],
        { cwd: pluginDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      installedPlugins = JSON.parse(stdout).plugins ?? [];
    } catch {
      throw new Error(
        "could not reach bb (`bb plugin list --json` failed) — is the app running?",
      );
    }

    const installed = await findInstalledPlugin(installedPlugins, pluginDir);
    if (!installed) {
      const sameId = installedPlugins.find((plugin) => plugin.id === pluginId);
      const detail = sameId?.rootDir
        ? `plugin "${pluginId}" is installed from ${sameId.rootDir}`
        : `plugin "${pluginId}" is not installed`;
      console.log(`${pluginName} dev watcher skipped: ${detail}`);
      return;
    }

    const typesExitCode = await runCommand(
      bb,
      ["plugin", "types", "."],
      pluginDir,
      setActiveChild,
    );
    if (typesExitCode !== 0) {
      throw new Error(`could not refresh SDK types for ${installed.id}`);
    }

    let snapshot = await snapshotPluginFiles(pluginDir);
    console.log(
      `Watching ${pluginDir} for plugin "${installed.id}" (${snapshot.size} files, polling) — Ctrl+C to stop.`,
    );

    for (;;) {
      if (stopping) break;
      await Promise.race([delay(POLL_INTERVAL_MS), stopRequested]);
      if (stopping) break;

      let next = await snapshotPluginFiles(pluginDir);
      const changed = new Set(changedPluginFiles(snapshot, next));
      snapshot = next;
      if (changed.size === 0) continue;

      await Promise.race([delay(DEBOUNCE_MS), stopRequested]);
      if (stopping) break;

      next = await snapshotPluginFiles(pluginDir);
      for (const path of changedPluginFiles(snapshot, next)) changed.add(path);
      snapshot = next;

      const startedAt = Date.now();
      if (hasApp) {
        const buildExitCode = await runCommand(
          "bun",
          ["run", "build"],
          pluginDir,
          setActiveChild,
        );
        if (stopping) break;
        if (buildExitCode !== 0) {
          console.error(
            `${changed.size} file${changed.size === 1 ? "" : "s"} changed · build failed — fix and save to retry`,
          );
          continue;
        }
      }

      const reloadExitCode = await runCommand(
        bb,
        ["plugin", "reload", installed.id],
        pluginDir,
        setActiveChild,
      );
      if (stopping) break;
      const elapsed = Math.max(0, Date.now() - startedAt);
      if (reloadExitCode === 0) {
        console.log(
          `${changed.size} file${changed.size === 1 ? "" : "s"} changed · ${hasApp ? "built and " : ""}reloaded ${installed.id} in ${elapsed}ms`,
        );
      } else {
        console.error(
          `${changed.size} file${changed.size === 1 ? "" : "s"} changed · reload failed for ${installed.id}`,
        );
      }
    }
  } finally {
    await releaseLock();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
