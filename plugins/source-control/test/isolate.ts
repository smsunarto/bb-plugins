/**
 * Every git and `but` a host test runs reads and writes only a temporary
 * directory: HOME, the XDG directories (where `but` keeps its project list
 * and settings on Linux; macOS keeps them under HOME), and git's global
 * config all point inside it. vitest runs each test file in its own process,
 * so this changes nothing outside the file that calls it.
 */
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type Isolated = {
  root: string;
  /** The real `but` found before HOME moved, or null when this machine has none. */
  but: string | null;
  cleanup(): Promise<void>;
};

function findBut(): string | null {
  const candidates = [
    ...(process.env["PATH"] ?? "").split(delimiter).filter((entry) => entry !== ""),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const directory of candidates) {
    const path = join(directory, "but");
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Not here.
    }
  }
  return null;
}

export async function isolate(prefix: string): Promise<Isolated> {
  const but = findBut();
  const root = await realpath(await mkdtemp(join(tmpdir(), `${prefix}-`)));
  const home = join(root, "home");
  const directories = {
    HOME: home,
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_STATE_HOME: join(root, "xdg-state"),
  };
  await Promise.all(Object.values(directories).map((path) => mkdir(path, { recursive: true })));
  const gitconfig = join(home, ".gitconfig");
  await writeFile(
    gitconfig,
    [
      "[user]",
      "  name = Test Person",
      "  email = test@example.com",
      "[commit]",
      "  gpgsign = false",
      "[tag]",
      "  gpgsign = false",
      "[init]",
      "  defaultBranch = main",
      "[advice]",
      "  detachedHead = false",
      "",
    ].join("\n"),
  );
  Object.assign(process.env, directories, {
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    // A pinned zone, so commit times read the same however the machine is set.
    TZ: "UTC",
  });
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "BUT_OUTPUT_FORMAT"]) {
    delete process.env[name];
  }
  if (but !== null) process.env["PATH"] = `${dirname(but)}${delimiter}${process.env["PATH"] ?? ""}`;
  return {
    root,
    but,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Refuses to go on unless `but` would read and write only inside `root`. */
export function assertIsolated(root: string): void {
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
    const value = process.env[name] ?? "";
    if (!value.startsWith(`${root}/`)) throw new Error(`${name} is not isolated: ${value}`);
  }
}
