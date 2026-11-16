/**
 * The pre-push gate. It typechecks and tests the workspace packages a push
 * changes, plus every package that depends on them. A change anywhere else,
 * such as root config, the lockfile, or scripts/, checks everything.
 *
 * lefthook passes git's pre-push stdin through: one
 * `<local ref> <local sha> <remote ref> <remote sha>` line per pushed ref.
 * With no lines, as when the hook runs by hand, everything is checked.
 *
 * It runs the steps of `bun run typecheck && bun run test` from package.json,
 * filtered to those packages. CI still runs those scripts unchanged.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Workspace {
  name: string;
  /** Repository-relative directory, such as `plugins/genui`. */
  dir: string;
  /** Workspace packages it depends on. */
  deps: string[];
  scripts: Record<string, string>;
}

const GROUPS = ["plugins", "packages"] as const;
const NO_COMMIT = /^0+$/;

export function readWorkspaces(root: string): Workspace[] {
  const workspaces: Workspace[] = [];
  for (const group of GROUPS) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const manifestPath = join(root, group, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const specs = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      };
      workspaces.push({
        name: manifest.name,
        dir: `${group}/${entry.name}`,
        deps: Object.keys(specs).filter((name) => String(specs[name]).startsWith("workspace:")),
        scripts: manifest.scripts ?? {},
      });
    }
  }
  return workspaces;
}

/** Every package that `files` can break, or "all" when a file outside a package changed. */
export function affected(
  files: readonly string[],
  workspaces: readonly Workspace[],
): Set<string> | "all" {
  const byDir = new Map(workspaces.map((workspace) => [workspace.dir, workspace.name]));
  const hit = new Set<string>();
  for (const file of files) {
    const owner = byDir.get(file.split("/").slice(0, 2).join("/"));
    if (owner === undefined) return "all";
    hit.add(owner);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const workspace of workspaces) {
      if (hit.has(workspace.name) || !workspace.deps.some((dep) => hit.has(dep))) continue;
      hit.add(workspace.name);
      grew = true;
    }
  }
  return hit;
}

function git(args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", ...args], { stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

/** The files the pushed commits change, or "all" when the range is unknown. */
export function pushedFiles(stdin: string): string[] | "all" {
  const lines = stdin.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return "all";
  const files = new Set<string>();
  for (const line of lines) {
    const [, local, , remote] = line.trim().split(/\s+/);
    if (local === undefined || remote === undefined) return "all";
    if (NO_COMMIT.test(local)) continue; // Deleting a ref pushes no code.
    const known =
      !NO_COMMIT.test(remote) && git(["cat-file", "-e", `${remote}^{commit}`]) !== undefined;
    const base = known ? remote : git(["merge-base", local, "origin/main"])?.trim();
    const diff = base ? git(["diff", "--name-only", "--no-renames", base, local]) : undefined;
    if (diff === undefined) return "all";
    for (const file of diff.split("\n")) if (file) files.add(file);
  }
  return [...files];
}

function run(command: string[]): void {
  console.log(`$ ${command.join(" ")}`);
  const started = performance.now();
  const { exitCode } = Bun.spawnSync(command, { stdio: ["inherit", "inherit", "inherit"] });
  console.log(`pre-push: ${command.slice(0, 3).join(" ")} took ${elapsed(started)}`);
  if (exitCode !== 0) process.exit(exitCode ?? 1);
}

function elapsed(started: number): string {
  return `${((performance.now() - started) / 1000).toFixed(1)}s`;
}

function filters(
  scope: Set<string>,
  workspaces: Workspace[],
  prefix: string,
  script: string,
): string[] {
  return workspaces.flatMap((w) =>
    scope.has(w.name) && w.name.startsWith(prefix) && script in w.scripts
      ? ["--filter", w.name]
      : [],
  );
}

if (import.meta.main) {
  const workspaces = readWorkspaces(process.cwd());
  // From a terminal, as when run by hand, there is no range to read.
  const files = pushedFiles(process.stdin.isTTY ? "" : await Bun.stdin.text());
  const found = files === "all" ? "all" : affected(files, workspaces);
  const scope = found === "all" ? new Set(workspaces.map((w) => w.name)) : found;
  console.log(
    found === "all"
      ? "pre-push: checking every package"
      : `pre-push: checking ${[...scope].sort().join(", ") || "repository scripts only"}`,
  );
  run(["bun", "run", "tsc", "-p", "tsconfig.json"]);
  for (const prefix of ["@smsunarto/bb-plugin-", "@bb-plugins/"]) {
    const picked = filters(scope, workspaces, prefix, "typecheck");
    if (picked.length > 0) run(["bun", "run", ...picked, "--parallel", "typecheck"]);
  }
  run(["bun", "test", ...new Bun.Glob("scripts/*.test.ts").scanSync()]);
  const plugins = filters(scope, workspaces, "@smsunarto/bb-plugin-", "test");
  if (plugins.length > 0) run(["bun", "run", ...plugins, "--sequential", "test"]);
  const packages = filters(scope, workspaces, "@bb-plugins/", "test");
  if (packages.length > 0) run(["bun", "run", ...packages, "--parallel", "test"]);
}
