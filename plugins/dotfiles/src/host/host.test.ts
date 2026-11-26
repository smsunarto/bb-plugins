import { afterAll, beforeAll, expect, jest, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry, { quoteForShell, runInLoginShell, type TaskTimers } from "./host.ts";

// Git hooks export GIT_DIR and friends. Inherited from a linked worktree's pre-push hook, they
// point this file's `git init` and commit at the real repository, which turns it bare.
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];

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

  expect(clean.repo).toBe("found");
  if (clean.repo !== "found") return;
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
  expect(dirty).toMatchObject({ repo: "found", entries: [{ status: "M", path: "AGENTS.md" }] });
});

test("a symlinked checkout reports its real directory, which bb's file API accepts as a root", async () => {
  const link = join(scratch, "dotfiles-link");
  await symlink(repo, link);

  const linked = await host.experimental_call("inspect", { repoPath: link });

  expect(linked).toMatchObject({ repo: "found", repoPath: await realpath(repo) });
});

test("a missing checkout reads as missing, with ~ expanded on this machine", async () => {
  const absent = `.dotfiles-host-test-${process.pid}`;
  const missing = await host.experimental_call("inspect", { repoPath: `~/${absent}` });

  expect(missing).toEqual({ repo: "missing", repoPath: join(homedir(), absent) });
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

/** Words a skill name or other argument could carry that a shell would otherwise act on. */
const hostileWords = [
  "",
  "plain",
  "two words",
  "it's",
  "trailing\\",
  "a\\'b",
  "\\\\'; touch pwned; echo '",
  "$(touch pwned)",
  "`touch pwned`",
  "$HOME $argv (echo x)",
  '"double" \\"escaped\\"',
  "~ * ? [a] {a,b} ; & | < > #",
  "line one\nline two",
  "tab\there",
  "ünïcödé ✓",
];

/** What `shell` prints for each word, one per line, when it reads them quoted for `family`. */
function echoed(shell: string, flags: readonly string[], family: "posix" | "fish"): string[] {
  const words = hostileWords.map((word) => quoteForShell(word, family)).join(" ");
  const output = execFileSync(shell, [...flags, `printf '%s\\0' ${words}`], {
    cwd: scratch,
    encoding: "utf8",
  });
  return output.split("\0").slice(0, -1);
}

const fish = ["/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/usr/bin/fish"].find((path) =>
  existsSync(path),
);

test("sh reads every quoted word back verbatim and runs none of it", () => {
  expect(echoed("/bin/sh", ["-c"], "posix")).toEqual(hostileWords);
  expect(existsSync(join(scratch, "pwned"))).toBe(false);
});

test.skipIf(fish === undefined)(
  "fish reads every quoted word back verbatim and runs none of it",
  () => {
    expect(echoed(fish ?? "", ["--no-config", "-c"], "fish")).toEqual(hostileWords);
    expect(existsSync(join(scratch, "pwned"))).toBe(false);
  },
);

test("POSIX quoting is not safe for fish, which is why the host quotes per shell", () => {
  // fish reads `\'` inside single quotes as an escaped quote, so this word never closes.
  expect(quoteForShell("trailing\\", "posix")).toBe("'trailing\\'");
  expect(quoteForShell("trailing\\", "fish")).toBe("'trailing\\\\'");
  expect(quoteForShell("it's", "fish")).toBe("'it\\'s'");
  expect(quoteForShell("it's", "posix")).toBe("'it'\\''s'");
  expect(() => quoteForShell("nul\0", "posix")).toThrow(/NUL/);
});

test("task arguments reach the command as literal words", async () => {
  const result = await host.experimental_call("run", {
    repoPath: repo,
    command: "printf '[%s]'",
    args: ["two words; echo $HOME", "*"],
  });

  expect(result.exitCode).toBe(0);
  expect(result.output.replace(noise, "")).toBe("[two words; echo $HOME][*]");
});

/** Real timers that remember which of them a task left pending or holding the process open. */
function recordingTimers() {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const refd = (timer: ReturnType<typeof setTimeout>) => timer.hasRef?.() ?? true;
  const timers: TaskTimers = {
    set: (run, ms) => {
      const timer = setTimeout(() => {
        pending.delete(timer);
        run();
      }, ms);
      pending.add(timer);
      return timer;
    },
    clear: (timer) => {
      pending.delete(timer);
      clearTimeout(timer);
    },
  };
  return {
    timers,
    /** Timers still scheduled that would keep the host daemon's event loop alive. */
    holding: () => [...pending].filter(refd).length,
    scheduled: () => pending.size,
    dispose: () => {
      for (const timer of pending) clearTimeout(timer);
    },
  };
}

test("a task that exits on its own leaves no timer behind", async () => {
  const recorded = recordingTimers();
  try {
    const result = await runInLoginShell(
      "exit 0",
      repo,
      new AbortController().signal,
      [],
      recorded.timers,
    );
    expect(result.exitCode).toBe(0);
    expect(recorded.scheduled()).toBe(0);
  } finally {
    recorded.dispose();
  }
});

test("a cancelled task that exits on SIGTERM leaves no timer holding the host open", async () => {
  const recorded = recordingTimers();
  const cancel = new AbortController();
  try {
    const call = runInLoginShell("sleep 30 & wait", repo, cancel.signal, [], recorded.timers);
    // Let the shell start and register its handlers before the stop.
    await new Promise((resolve) => setTimeout(resolve, 200));
    cancel.abort();

    // It settles on close, well before the 2 s SIGKILL grace.
    expect(await within(1_500, call)).toEqual({ exitCode: 1, output: `${noise}\n[cancelled]` });
    expect(recorded.holding()).toBe(0);
  } finally {
    recorded.dispose();
  }
}, 15_000);
