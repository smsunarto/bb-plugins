import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Tweakable registry — mirrors the sources-of-truth table in AGENTS.md.
// Paths are repo-relative. `render` marks files whose generated consumers
// need `mise run render` after an edit.
// ---------------------------------------------------------------------------

interface Tweakable {
  path: string;
  title: string;
  note?: string;
  render?: boolean;
}

interface TweakableGroup {
  id: string;
  title: string;
  files: Tweakable[];
}

const STATIC_GROUPS: TweakableGroup[] = [
  {
    id: "agents",
    title: "Agent config",
    files: [
      {
        path: ".dotfiles/mcp.json",
        title: "MCP servers",
        note: "Renders into ~/.claude.json and ~/.codex/config.toml",
        render: true,
      },
      {
        path: ".dotfiles/.agents/instructions/shared.md",
        title: "Instructions: shared",
        note: "Renders into CLAUDE.md and AGENTS.md",
        render: true,
      },
      {
        path: ".dotfiles/.agents/instructions/claude.md",
        title: "Instructions: claude",
        note: "Renders into ~/.claude/CLAUDE.md",
        render: true,
      },
      {
        path: ".dotfiles/.agents/instructions/codex.md",
        title: "Instructions: codex",
        note: "Renders into ~/.codex/AGENTS.md",
        render: true,
      },
    ],
  },
  {
    id: "seeds",
    title: "Seed settings",
    files: [
      {
        path: ".dotfiles/.claude/settings.json",
        title: "Claude settings seed",
        note: "Copied only when ~/.claude/settings.json is missing",
      },
      {
        path: ".dotfiles/.codex/config.macos.toml",
        title: "Codex seed (macOS)",
      },
      {
        path: ".dotfiles/.codex/config.linux.toml",
        title: "Codex seed (Linux)",
      },
    ],
  },
  {
    id: "shell",
    title: "Shell",
    files: [
      {
        path: ".dotfiles/.config/fish/config.fish",
        title: "config.fish",
        note: "Live symlink — edits apply immediately",
      },
      { path: ".dotfiles/.config/starship.toml", title: "starship prompt" },
      { path: ".dotfiles/.gitconfig", title: ".gitconfig" },
    ],
  },
  {
    id: "mise",
    title: "Mise",
    files: [
      { path: "mise.toml", title: "mise.toml", note: "Mappings, tasks, checks (portable only)" },
      { path: "mise.macos.toml", title: "mise.macos.toml", note: "Homebrew + macOS state" },
      { path: "mise.linux.toml", title: "mise.linux.toml", note: "apt + yui state" },
      {
        path: ".dotfiles/.config/mise/config.toml",
        title: "Global mise config",
        note: "The only [tools]/[env] declaration",
      },
    ],
  },
  {
    id: "python",
    title: "Python",
    files: [
      {
        path: "python-packages.txt",
        title: "python-packages.txt",
        note: "Shared libraries for the bare python3",
      },
      { path: "python-tools.txt", title: "python-tools.txt", note: "CLI tools installed with uv tool" },
    ],
  },
  {
    id: "repo",
    title: "Repo policy",
    files: [{ path: "AGENTS.md", title: "AGENTS.md", note: "Repository agent guide" }],
  },
];

// Tasks the plugin may run, keyed by a stable id. `sync` publishes (pushes);
// everything else is local-only.
const TASKS: Record<string, { command: string; summary: string }> = {
  render: { command: "mise run render", summary: "Render generated agent configs" },
  check: { command: "mise run check", summary: "Full repository validation" },
  "check:mise": { command: "mise run check:mise", summary: "Validate mise + mappings" },
  "check:shell": { command: "mise run check:shell", summary: "Validate fish + script syntax" },
  "check:mcp": { command: "mise run check:mcp", summary: "Validate MCP JSON + renderer" },
  "check:python": { command: "mise run check:python", summary: "Validate Python runtime, libs, tools" },
  "check:skills": { command: "mise run check:skills", summary: "Validate skill manifests" },
  "check:dotfiles": { command: "mise run check:dotfiles", summary: "Validate dotfile mappings apply" },
  "check:safety": { command: "mise run check:safety", summary: "Reject forced dotfile applies" },
  "check:secrets": { command: "mise run check:secrets", summary: "Reject tracked secret injection" },
  "apply:dry": {
    command: "mise dotfiles apply --dry-run --verbose",
    summary: "Preview dotfile application",
  },
  "sync:pull": { command: "mise run sync:pull", summary: "Consume-only sync (fast-forward + apply)" },
  sync: { command: "mise run sync", summary: "Publish: rebase, push, re-apply, render" },
};

const OUTPUT_CAP = 200_000;

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function discoverSkills(repoPath: string): Tweakable[] {
  const skillsDir = join(repoPath, ".dotfiles/.agents/skills");
  if (!existsSync(skillsDir)) return [];
  const skills: Tweakable[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(manifest)) continue;
    skills.push({
      path: `.dotfiles/.agents/skills/${entry.name}/SKILL.md`,
      title: entry.name,
    });
  }
  return skills.sort((a, b) => a.title.localeCompare(b.title));
}

// fish splits its startup across conf.d, so the drop-ins are as tweakable as
// config.fish itself. Discovering them keeps the panel honest when one is
// added or removed. Functions stay out: they are a library, not config.
function discoverFishDropins(repoPath: string): Tweakable[] {
  const confDir = join(repoPath, ".dotfiles/.config/fish/conf.d");
  if (!existsSync(confDir)) return [];
  return readdirSync(confDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".fish"))
    .map((entry) => ({
      path: `.dotfiles/.config/fish/conf.d/${entry.name}`,
      title: `conf.d/${entry.name}`,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

function buildGroups(repoPath: string): TweakableGroup[] {
  return [
    ...STATIC_GROUPS.map((group) =>
      group.id === "shell"
        ? {
            ...group,
            // Keep the fish files adjacent: drop-ins follow config.fish, ahead
            // of the prompt and git config.
            files: group.files.flatMap((file) =>
              file.path.endsWith("fish/config.fish")
                ? [file, ...discoverFishDropins(repoPath)]
                : [file],
            ),
          }
        : group,
    ),
    { id: "skills", title: "Skills", files: discoverSkills(repoPath) },
  ];
}

function allowedPaths(repoPath: string): Set<string> {
  const paths = new Set<string>();
  for (const group of buildGroups(repoPath)) {
    for (const file of group.files) paths.add(file.path);
  }
  return paths;
}

// Tasks run in a login shell so mise/git resolve from the user's normal PATH.
// fish is the repo's only shell, but it is never at a fixed path (Homebrew on
// macOS, /usr/bin on Linux), so probe the usual homes and keep sh as the
// fallback for a machine where fish is not installed yet.
const LOGIN_SHELL: { path: string; args: string[] } = (() => {
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
})();

function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 300_000,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(LOGIN_SHELL.path, [...LOGIN_SHELL.args, command], { cwd });
    let output = "";
    const append = (chunk: Buffer) => {
      if (output.length < OUTPUT_CAP) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      output += `\n[timed out after ${timeoutMs / 1000}s]`;
    }, timeoutMs);
    // A spawn can emit `error` and `close`, or just one of them, so both
    // handlers must be able to settle. Whichever fires first wins and the
    // other call is a no-op — that race is the point, not a defect.
    /* oxlint-disable promise/no-multiple-resolved */
    child.on("close", (code) => {
      clearTimeout(timer);
      if (output.length >= OUTPUT_CAP) output = `${output.slice(0, OUTPUT_CAP)}\n[output truncated]`;
      resolvePromise({ exitCode: code ?? 1, output });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: 127, output: `${output}\n${String(error)}` });
    });
    /* oxlint-enable promise/no-multiple-resolved */
  });
}

// One working-tree change, shaped for the panel's file tree. `code` is the raw
// two-letter porcelain status; `status` is the coarse form Pierre Trees paints.
export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: "added" | "deleted" | "modified" | "renamed";
  code: string;
}

// git quotes paths with non-ASCII or control characters using C escapes, which
// JSON.parse decodes for the common cases.
function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw.slice(1, -1);
  }
}

function classify(code: string): ChangedFile["status"] {
  if (code === "??") return "added";
  const letters = code.replace(/ /g, "");
  if (letters.includes("R")) return "renamed";
  if (letters.includes("D")) return "deleted";
  if (letters.includes("A") || letters.includes("C")) return "added";
  return "modified";
}

function parseStatusLine(line: string): ChangedFile {
  const code = line.slice(0, 2);
  const rest = line.slice(3);
  const arrow = rest.indexOf(" -> ");
  if (arrow === -1) {
    return { path: unquotePath(rest), status: classify(code), code: code.trim() };
  }
  return {
    path: unquotePath(rest.slice(arrow + 4)),
    previousPath: unquotePath(rest.slice(0, arrow)),
    status: classify(code),
    code: code.trim(),
  };
}

async function gitStatus(repoPath: string): Promise<{ branch: string; files: ChangedFile[] }> {
  // -uall expands untracked directories into files; without it git reports a
  // single "dir/" entry, which has no leaf to show in the file tree.
  const { exitCode, output } = await runCommand(
    "git status --porcelain=v1 -b -uall",
    repoPath,
    30_000,
  );
  if (exitCode !== 0) return { branch: "unknown", files: [] };
  const lines = output.split("\n").filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## "));
  const branch = branchLine ? branchLine.slice(3).split("...")[0]! : "unknown";
  const files = lines.filter((line) => !line.startsWith("## ")).map(parseStatusLine);
  return { branch, files };
}

// ---------------------------------------------------------------------------
// RPC contract (imported type-only by app.tsx)
// ---------------------------------------------------------------------------

const fileSchema = z.object({
  path: z.string(),
  title: z.string(),
  note: z.string().optional(),
  render: z.boolean().optional(),
  exists: z.boolean(),
  dirty: z.boolean(),
});

export const rpcContract = defineRpcContract({
  overview: {
    input: z.null(),
    output: z.object({
      repoPath: z.string(),
      branch: z.string(),
      groups: z.array(
        z.object({ id: z.string(), title: z.string(), files: z.array(fileSchema) }),
      ),
      changedFiles: z.array(
        z.object({
          path: z.string(),
          previousPath: z.string().optional(),
          status: z.enum(["added", "deleted", "modified", "renamed"]),
          code: z.string(),
        }),
      ),
      tasks: z.array(z.object({ id: z.string(), summary: z.string() })),
    }),
  },
  readFile: {
    input: z.object({ path: z.string() }).strict(),
    output: z.object({
      content: z.string(),
      sha256: z.string(),
      headContent: z.string().nullable(),
    }),
  },
  saveFile: {
    input: z
      .object({ path: z.string(), content: z.string(), expectedSha256: z.string() })
      .strict(),
    output: z.object({
      outcome: z.enum(["written", "conflict"]),
      sha256: z.string().nullable(),
      renderHint: z.boolean(),
    }),
  },
  runTask: {
    input: z.object({ task: z.string() }).strict(),
    output: z.object({ exitCode: z.number(), output: z.string() }),
  },
  removeSkill: {
    input: z.object({ name: z.string() }).strict(),
    output: z.object({ exitCode: z.number(), output: z.string() }),
  },
});

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    repoPath: {
      type: "string",
      label: "Dotfiles repo path (on the bb server host)",
      default: "",
    },
  });

  async function repoPath(): Promise<string> {
    const { repoPath: raw } = await settings.get();
    const configured = raw.trim();
    if (!configured) {
      throw new Error("dotfiles repo path is not configured");
    }
    return expandHome(configured);
  }

  // Openable = a registered tweakable, or any path git currently reports as
  // changed. The changed-file tree lists the second kind, so a row there has to
  // open (and save) like a tweakable does.
  async function requireOpenable(repo: string, path: string): Promise<void> {
    if (allowedPaths(repo).has(path)) return;
    const { files } = await gitStatus(repo);
    if (files.some((file) => file.path === path)) return;
    throw new Error(`not a tweakable or changed file: ${path}`);
  }

  async function readTweakable(repo: string, path: string) {
    const file = await bb.sdk.files.read({ path: join(repo, path) });
    if (file.contentEncoding !== "utf8") {
      throw new Error(`not a text file: ${path} (${file.contentEncoding})`);
    }
    return { content: file.content, sha256: file.sha256 };
  }

  bb.rpc.register(rpcContract, {
    async overview() {
      const repo = await repoPath();
      const { branch, files: changedFiles } = existsSync(repo)
        ? await gitStatus(repo)
        : { branch: "missing", files: [] as ChangedFile[] };
      const dirtySet = new Set<string>();
      for (const file of changedFiles) {
        dirtySet.add(file.path);
        if (file.previousPath) dirtySet.add(file.previousPath);
      }
      const groups = buildGroups(repo).map((group) => ({
        id: group.id,
        title: group.title,
        files: group.files.map((file) => ({
          ...file,
          exists: existsSync(join(repo, file.path)),
          dirty: dirtySet.has(file.path),
        })),
      }));
      return {
        repoPath: repo,
        branch,
        groups,
        changedFiles,
        tasks: Object.entries(TASKS).map(([id, task]) => ({ id, summary: task.summary })),
      };
    },
    async readFile({ path }) {
      const repo = await repoPath();
      await requireOpenable(repo, path);
      const file = await readTweakable(repo, path);
      // HEAD version for the diff view; null when untracked or not in HEAD.
      const head = await runCommand(`git show HEAD:${JSON.stringify(path)}`, repo, 30_000);
      return { ...file, headContent: head.exitCode === 0 ? head.output : null };
    },
    async saveFile({ path, content, expectedSha256 }) {
      const repo = await repoPath();
      await requireOpenable(repo, path);
      const saved = await bb.sdk.files.write({
        path: join(repo, path),
        rootPath: repo,
        content,
        expectedSha256,
      });
      const renderHint =
        saved.outcome === "written" &&
        STATIC_GROUPS.some((group) =>
          group.files.some((file) => file.path === path && file.render),
        );
      return {
        outcome: saved.outcome,
        sha256: saved.outcome === "written" ? saved.sha256 : null,
        renderHint,
      };
    },
    async removeSkill({ name }) {
      const repo = await repoPath();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid skill name: ${name}`);
      const known = discoverSkills(repo).some((skill) => skill.title === name);
      if (!known) throw new Error(`unknown skill: ${name}`);
      bb.log.info(`removing skill ${name} via npx skills`);
      return runCommand(`npx -y skills remove ${name} -g -y`, repo);
    },
    async runTask({ task }) {
      const spec = TASKS[task];
      if (!spec) throw new Error(`unknown task: ${task}`);
      const repo = await repoPath();
      bb.log.info(`running task ${task}: ${spec.command}`);
      return runCommand(spec.command, repo);
    },
  });

  bb.cli.register({
    name: "dotfiles",
    summary: "Manage the tweakable dotfiles repo (list, status, cat, render, check, sync)",
    commands: [
      { name: "list", summary: "List tweakable files with dirty markers", usage: "bb dotfiles list" },
      { name: "status", summary: "Git status of the dotfiles repo", usage: "bb dotfiles status" },
      { name: "cat", summary: "Print a tweakable file", usage: "bb dotfiles cat <repo-relative-path>" },
      { name: "render", summary: "Run scripts/render-agent-config via mise", usage: "bb dotfiles render" },
      {
        name: "check",
        summary:
          "Run repo validation (optionally one target: mise|shell|mcp|python|skills|dotfiles|safety|secrets)",
        usage: "bb dotfiles check [target]",
      },
      {
        name: "sync",
        summary: "Sync the repo; default is consume-only, --publish pushes",
        usage: "bb dotfiles sync [--publish]",
      },
    ],
    async run(argv) {
      const repo = await repoPath();
      const [command, ...rest] = argv;
      if (!existsSync(repo)) {
        return { exitCode: 1, stderr: `dotfiles repo not found at ${repo}` };
      }
      switch (command) {
        case "list": {
          const { files } = await gitStatus(repo);
          const dirtySet = new Set(files.map((file) => file.path));
          const lines: string[] = [];
          for (const group of buildGroups(repo)) {
            lines.push(`# ${group.title}`);
            for (const file of group.files) {
              const flags = [
                dirtySet.has(file.path) ? "dirty" : "",
                file.render ? "renders" : "",
                existsSync(join(repo, file.path)) ? "" : "MISSING",
              ]
                .filter(Boolean)
                .join(", ");
              lines.push(`  ${file.path}${flags ? `  [${flags}]` : ""}`);
            }
          }
          return { exitCode: 0, stdout: lines.join("\n") };
        }
        case "status": {
          const { branch, files } = await gitStatus(repo);
          const body = files
            .map((file) => `${file.code.padEnd(2)} ${file.path}`)
            .join("\n");
          return {
            exitCode: 0,
            stdout: `branch: ${branch}\n${body || "clean"}`,
          };
        }
        case "cat": {
          const path = rest[0];
          if (!path) return { exitCode: 2, stderr: "usage: bb dotfiles cat <repo-relative-path>" };
          try {
            await requireOpenable(repo, path);
            const { content } = await readTweakable(repo, path);
            return { exitCode: 0, stdout: content };
          } catch (error) {
            return { exitCode: 1, stderr: String(error instanceof Error ? error.message : error) };
          }
        }
        case "render": {
          const result = await runCommand(TASKS.render!.command, repo);
          return { exitCode: result.exitCode, stdout: result.output };
        }
        case "check": {
          const target = rest[0];
          const taskId = target ? `check:${target}` : "check";
          const spec = TASKS[taskId];
          if (!spec) return { exitCode: 2, stderr: `unknown check target: ${target}` };
          const result = await runCommand(spec.command, repo);
          return { exitCode: result.exitCode, stdout: result.output };
        }
        case "sync": {
          const taskId = rest.includes("--publish") ? "sync" : "sync:pull";
          const result = await runCommand(TASKS[taskId]!.command, repo);
          return { exitCode: result.exitCode, stdout: result.output };
        }
        default:
          return {
            exitCode: 2,
            stderr:
              "usage: bb dotfiles <list|status|cat|render|check|sync>\n" +
              "  list              list tweakable files\n" +
              "  status            git status of the repo\n" +
              "  cat <path>        print a tweakable file\n" +
              "  render            render generated agent configs\n" +
              "  check [target]    run validation (mise|shell|mcp|python|skills|dotfiles|safety|secrets)\n" +
              "  sync [--publish]  pull-only sync, or publish with --publish",
          };
      }
    },
  });

  const initial = await settings.get();
  const configuredRepoPath = initial.repoPath.trim();
  if (!configuredRepoPath) {
    bb.status.needsConfiguration(
      "Set repoPath to your dotfiles repository with `bb plugin config dotfiles`, then reload.",
    );
  } else if (!existsSync(expandHome(configuredRepoPath))) {
    bb.status.needsConfiguration(
      `Dotfiles repo not found at ${configuredRepoPath}. Set repoPath with \`bb plugin config dotfiles\`, then reload.`,
    );
  }
}
