import { afterAll, beforeAll, expect, jest, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./host.ts";

const host = experimental_createHostEntryHarness(hostEntry);
const noise =
  "source: Error encountered while sourcing file '/Users/example/.unity/env.fish':\n" +
  "source: No such file or directory\n";
const environment = ["SHELL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
const original = Object.fromEntries(environment.map((name) => [name, process.env[name]]));
let scratch = "";
let repo = "";

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killQuietly(pids: readonly number[]): void {
  // A pid of 0 or below would signal this test's own process group.
  for (const pid of pids) if (pid > 0 && running(pid)) process.kill(pid, "SIGKILL");
}

/** Polls for about 5 s of real time, so it also holds under fake timers. */
async function eventually(probe: () => boolean): Promise<boolean> {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 200; attempt++) {
    if (probe()) return true;
    await new Promise((resolve) => setImmediate(resolve));
    Atomics.wait(pause, 0, 0, 25);
  }
  return probe();
}

/** The space-separated pids a task wrote to `file`. */
async function pidsIn(file: string): Promise<number[]> {
  const written = () => existsSync(file) && readFileSync(file, "utf8").endsWith("\n");
  expect(await eventually(written)).toBe(true);
  return readFileSync(file, "utf8").trim().split(" ").map(Number);
}

async function within<T>(ms: number, work: Promise<T>): Promise<T | "still running"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"still running">((resolve) => {
    timer = setTimeout(resolve, ms, "still running");
  });
  try {
    return await Promise.race([work, bound]);
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "dotfiles-host-"));
  repo = join(scratch, "dotfiles");
  // A login shell whose config fails on this machine, the way a shared fish
  // config sourcing a Mac-only file fails on Linux: noise on stderr, then the
  // command runs.
  const shell = join(scratch, "bin/fish");
  await mkdir(join(scratch, "bin"));
  await writeFile(shell, `#!/bin/sh\nprintf "%s" "${noise}" >&2\nshift\nexec /bin/sh -c "$2"\n`);
  await chmod(shell, 0o755);
  process.env.SHELL = shell;
  // A process that leaves the task's group, the way a daemonizing tool does,
  // reports `<member pid> <own pid>`, then sleeps holding the task's pipes.
  await writeFile(
    join(scratch, "bin/escape.pl"),
    [
      'use POSIX "setsid";',
      "my ($file, $member) = splice @ARGV, 0, 2;",
      'setsid() or die "setsid: $!";',
      'open my $out, ">", $file or die "$file: $!";',
      'print $out "$member $$\\n";',
      "close $out;",
      "exec @ARGV;",
      "",
    ].join("\n"),
  );
  // The reader's own git config must not shape what the host parses.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  await mkdir(join(repo, ".dotfiles/.agents/skills/example"), { recursive: true });
  await writeFile(join(repo, "AGENTS.md"), "# dotfiles\n");
  await writeFile(join(repo, ".dotfiles/.agents/skills/example/SKILL.md"), "---\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

afterAll(async () => {
  for (const name of environment) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
  await rm(scratch, { recursive: true, force: true });
});

test("git data stays clean when the login shell writes to stderr", async () => {
  const clean = await host.experimental_call("inspect", { repoPath: repo });

  expect(clean.repoExists).toBe(true);
  expect(clean.branch).toBe("main");
  expect(clean.entries).toEqual([]);
  expect(clean.skills).toEqual([
    { path: ".dotfiles/.agents/skills/example/SKILL.md", title: "example" },
  ]);
  expect(clean.missingPaths).not.toContain("AGENTS.md");
  expect(clean.missingPaths).toContain("mise.toml");
  expect(await host.experimental_call("readHead", { repoPath: repo, path: "AGENTS.md" })).toEqual({
    content: "# dotfiles\n",
  });

  await writeFile(join(repo, "AGENTS.md"), "# dotfiles, edited\n");
  const dirty = await host.experimental_call("inspect", { repoPath: repo });
  expect(dirty.entries).toEqual([{ status: "M", path: "AGENTS.md" }]);
});

test("a symlinked checkout reports its real directory, which bb's file API accepts as a root", async () => {
  const link = join(scratch, "dotfiles-link");
  await symlink(repo, link);

  const linked = await host.experimental_call("inspect", { repoPath: link });

  expect(linked.repoExists).toBe(true);
  expect(linked.repoPath).toBe(await realpath(repo));
});

test("a missing checkout reads as missing, with ~ expanded on this machine", async () => {
  const absent = `.dotfiles-host-test-${process.pid}`;
  const missing = await host.experimental_call("inspect", { repoPath: `~/${absent}` });

  expect(missing).toMatchObject({
    repoPath: join(homedir(), absent),
    repoExists: false,
    branch: "missing",
    entries: [],
    skills: [],
  });
  expect(
    await host.experimental_call("readHead", { repoPath: `~/${absent}`, path: "AGENTS.md" }),
  ).toEqual({ content: null });
});

test("tasks run in the checkout through the login shell, output merged for display", async () => {
  const result = await host.experimental_call("run", { repoPath: repo, command: "pwd" });
  expect(result.exitCode).toBe(0);
  // Separate stdout/stderr pipes can arrive in either order.
  expect(result.output).toContain(noise);
  expect(result.output.replace(noise, "")).toBe(`${await realpath(repo)}\n`);
  expect(await host.experimental_call("run", { repoPath: repo, command: "exit 3" })).toEqual({
    exitCode: 3,
    output: noise,
  });
});

test("a timed-out task stops every process it started", async () => {
  const pidFile = join(scratch, "timeout.pid");
  let pids: number[] = [];
  jest.useFakeTimers();
  try {
    const call = host.experimental_call("run", {
      repoPath: repo,
      command: `sleep 30 & echo $! > '${pidFile}'; wait`,
    });
    pids = await pidsIn(pidFile);
    jest.advanceTimersByTime(300_000);
    jest.useRealTimers();

    expect(await within(2_000, call)).toEqual({
      exitCode: 1,
      output: `${noise}\n[timed out after 300s]`,
    });
    expect(await eventually(() => !pids.some(running))).toBe(true);
  } finally {
    jest.useRealTimers();
    killQuietly(pids);
  }
}, 15_000);

test("a cancelled task settles even while a process that left its group holds its output", async () => {
  const pidFile = join(scratch, "cancel.pid");
  const escape = join(scratch, "bin/escape.pl");
  const cancel = new AbortController();
  let pids: number[] = [];
  try {
    const call = host.experimental_call(
      "run",
      { repoPath: repo, command: `sleep 30 & perl '${escape}' '${pidFile}' $! sleep 30 & wait` },
      { signal: cancel.signal },
    );
    pids = await pidsIn(pidFile);
    expect(pids).toHaveLength(2);
    const [member, escaped] = pids as [number, number];
    cancel.abort();

    // SIGTERM, 2 s grace, SIGKILL, then 1 s for the pipes before settling.
    expect(await within(5_000, call)).toEqual({ exitCode: 1, output: `${noise}\n[cancelled]` });
    expect(await eventually(() => !running(member))).toBe(true);
    // It never closed the pipes, so the call did not wait for it.
    expect(running(escaped)).toBe(true);
  } finally {
    killQuietly(pids);
  }
}, 15_000);
