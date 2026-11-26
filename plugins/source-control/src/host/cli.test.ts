/**
 * Stopping a command stops everything it started: each runs in its own
 * process group, which gets SIGTERM and then, after a grace period, SIGKILL.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CommandFailedError, runGitCommand } from "./cli.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "source-control-cli-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function alive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits up to `ms` for the process group to be gone; how long it took, or null. */
async function goneWithin(pgid: number, ms: number): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (!alive(pgid)) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/**
 * A git alias whose shell ignores SIGTERM and writes its process group,
 * once it is ready, to a file of its own.
 */
async function stubbornAlias(
  name: string,
): Promise<{ args: string[]; pgid: () => Promise<number> }> {
  const pgidFile = join(root, `${name}.pgid`);
  const script = join(root, `${name}.sh`);
  await writeFile(
    script,
    [
      `trap '' TERM`,
      `ps -o pgid= -p $$ | tr -d ' ' > '${pgidFile}.tmp'`,
      `mv '${pgidFile}.tmp' '${pgidFile}'`,
      `sleep 30`,
    ].join("\n"),
  );
  await chmod(script, 0o755);
  return {
    args: ["-c", `alias.${name}=!sh '${script}'`, name],
    pgid: async () => {
      for (let tries = 0; tries < 100; tries += 1) {
        const text = await readFile(pgidFile, "utf8").catch(() => "");
        if (text.trim() !== "") return Number(text.trim());
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("the stub never started");
    },
  };
}

const ownGroup = Number(
  execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)])
    .toString()
    .trim(),
);

test.skipIf(process.platform === "win32")(
  "a timed-out command fails clearly, and a group ignoring SIGTERM is killed",
  async () => {
    const stub = await stubbornAlias("stubborn");
    const running = runGitCommand(root, stub.args, new AbortController().signal, {
      timeoutMs: 1_000,
      own: false,
    });
    // Prevent unhandled rejection if an earlier assertion throws.
    running.catch(() => undefined);
    const pgid = await stub.pgid();
    // Its own group, so stopping it never signals the host.
    expect(pgid).not.toBe(ownGroup);
    await expect(running).rejects.toBeInstanceOf(CommandFailedError);
    await expect(running).rejects.toThrow(/did not finish within 1 second/);
    // SIGTERM is ignored, so the group outlives it until SIGKILL.
    expect(alive(pgid)).toBe(true);
    const gone = await goneWithin(pgid, 6_000);
    expect(gone).not.toBeNull();
    expect(gone!).toBeGreaterThan(1_000);
  },
  15_000,
);

test.skipIf(process.platform === "win32")(
  "an aborted command settles at once and its group is killed",
  async () => {
    const stub = await stubbornAlias("aborted");
    const controller = new AbortController();
    const running = runGitCommand(root, stub.args, controller.signal, { own: false });
    const pgid = await stub.pgid();
    const reason = new Error("superseded");
    const started = Date.now();
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(500);
    expect(await goneWithin(pgid, 6_000)).not.toBeNull();
  },
  15_000,
);

test("a command that finishes is unaffected by the timeout", async () => {
  const result = await runGitCommand(root, ["--version"], new AbortController().signal, {
    timeoutMs: 10_000,
    own: false,
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(/^git version/);
});
