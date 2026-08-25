import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GitEntry, TaskResult, TweakableDefinition } from "./domain.ts";

const outputCap = 200_000;
const defaultTimeoutMs = 300_000;

interface LoginShell {
  readonly path: string;
  readonly args: readonly string[];
}

/** Everything the rpc and cli handlers consume — the DI seam for tests. */
export interface DotfilesGit {
  getRepoPath(): Promise<string>;
  repoExists(repoPath: string): boolean;
  pathExists(repoPath: string, path: string): boolean;
  discoverSkills(repoPath: string): readonly TweakableDefinition[];
  gitStatus(repoPath: string): Promise<{
    branch: string;
    entries: GitEntry[];
  }>;
  readFile(
    repoPath: string,
    path: string,
  ): Promise<{
    content: string;
    sha256: string;
  }>;
  readHeadFile(repoPath: string, path: string): Promise<string | null>;
  writeFile(
    repoPath: string,
    path: string,
    content: string,
    expectedSha256: string,
  ): Promise<{ outcome: "written"; sha256: string } | { outcome: "conflict" }>;
  run(repoPath: string, command: string): Promise<TaskResult>;
  removeSkill(repoPath: string, name: string): Promise<TaskResult>;
}

export interface GitDependencies {
  readonly files: BbPluginApi["sdk"]["files"];
  readonly getConfiguredRepoPath: () => Promise<string>;
}

export interface ManagedDotfilesGit extends DotfilesGit {
  dispose(): void;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function resolveLoginShell(): LoginShell {
  const candidates = [
    process.env.SHELL,
    "/opt/homebrew/bin/fish",
    "/usr/local/bin/fish",
    "/usr/bin/fish",
  ];
  for (const candidate of candidates) {
    if (candidate?.endsWith("/fish") && existsSync(candidate)) {
      return { path: candidate, args: ["-l", "-c"] };
    }
  }
  return { path: "/bin/sh", args: ["-lc"] };
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function createDotfilesGit({
  files,
  getConfiguredRepoPath,
}: GitDependencies): ManagedDotfilesGit {
  const loginShell = resolveLoginShell();
  const activeChildren = new Set<ChildProcess>();

  function runCommand(
    command: string,
    cwd: string,
    timeoutMs = defaultTimeoutMs,
  ): Promise<TaskResult> {
    return new Promise((resolvePromise) => {
      const child = spawn(loginShell.path, [...loginShell.args, command], { cwd });
      activeChildren.add(child);
      let output = "";
      let truncated = false;
      let settled = false;

      const append = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        const remaining = outputCap - output.length;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        output += text.slice(0, remaining);
        if (text.length > remaining) truncated = true;
      };

      const settle = (result: TaskResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeChildren.delete(child);
        // Both `error` and `close` can fire. The `settled` guard makes this
        // exact-once even though static promise lint cannot prove it.
        /* oxlint-disable-next-line promise/no-multiple-resolved */
        resolvePromise(result);
      };

      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const timer = setTimeout(() => {
        output += `\n[timed out after ${timeoutMs / 1000}s]`;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("close", (code) => {
        settle({
          exitCode: code ?? 1,
          output: `${output}${truncated ? "\n[output truncated]" : ""}`,
        });
      });
      child.on("error", (error) => {
        settle({
          exitCode: 127,
          output: `${output}${output ? "\n" : ""}${String(error)}`,
        });
      });
    });
  }

  function discoverSkills(repoPath: string): readonly TweakableDefinition[] {
    const skillsDirectory = join(repoPath, ".dotfiles/.agents/skills");
    if (!existsSync(skillsDirectory)) return [];
    return readdirSync(skillsDirectory, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(skillsDirectory, entry.name, "SKILL.md")),
      )
      .map((entry) => ({
        path: `.dotfiles/.agents/skills/${entry.name}/SKILL.md`,
        title: entry.name,
      }))
      .sort((left, right) => left.title.localeCompare(right.title));
  }

  return {
    async getRepoPath() {
      return expandHome(await getConfiguredRepoPath());
    },

    repoExists: existsSync,

    pathExists(repoPath, path) {
      return existsSync(join(repoPath, path));
    },

    discoverSkills,

    async gitStatus(repoPath) {
      const result = await runCommand("git status --porcelain=v1 -b", repoPath, 30_000);
      if (result.exitCode !== 0) return { branch: "unknown", entries: [] };
      const lines = result.output.split("\n").filter(Boolean);
      const branchLine = lines.find((line) => line.startsWith("## "));
      const branch = branchLine?.slice(3).split("...")[0] ?? "unknown";
      return {
        branch,
        entries: lines
          .filter((line) => !line.startsWith("## "))
          .map((line) => ({
            status: line.slice(0, 2).trim(),
            path: line.slice(3),
          })),
      };
    },

    async readFile(repoPath, path) {
      const file = await files.read({ path: join(repoPath, path) });
      if (file.contentEncoding !== "utf8") {
        throw new Error(`not a text file: ${path} (${file.contentEncoding})`);
      }
      return { content: file.content, sha256: file.sha256 };
    },

    async readHeadFile(repoPath, path) {
      const result = await runCommand(`git show HEAD:${quoteShell(path)}`, repoPath, 30_000);
      return result.exitCode === 0 ? result.output : null;
    },

    async writeFile(repoPath, path, content, expectedSha256) {
      const result = await files.write({
        path: join(repoPath, path),
        rootPath: repoPath,
        content,
        expectedSha256,
      });
      return result.outcome === "written"
        ? { outcome: "written", sha256: result.sha256 }
        : { outcome: "conflict" };
    },

    run(repoPath, command) {
      return runCommand(command, repoPath);
    },

    removeSkill(repoPath, name) {
      return runCommand(`npx -y skills remove ${quoteShell(name)} -g -y`, repoPath);
    },

    dispose() {
      for (const child of activeChildren) child.kill("SIGKILL");
      activeChildren.clear();
    },
  };
}

const gits = new WeakMap<object, ManagedDotfilesGit>();

/**
 * The one git collaborator per plugin instance. Identity is the host
 * object, so two tests (and two plugin loads) never share children.
 * `setup` binds the production instance; tests call `bindGit` via
 * `provideFakeGit`.
 */
export function gitFor(bb: object): ManagedDotfilesGit {
  const existing = gits.get(bb);
  if (!existing) {
    throw new Error("dotfiles git is not bound for this host");
  }
  return existing;
}

export function bindGit(bb: object, git: ManagedDotfilesGit): void {
  gits.set(bb, git);
}
