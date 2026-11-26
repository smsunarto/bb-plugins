import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runGroupProcess } from "./group-process";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "slopcop-group-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Starts a background grandchild that records its pid, then waits on it. */
async function spawnTree(signal: AbortSignal, timeout: number, script = "") {
  const pidFile = path.join(dir, "grandchild.pid");
  const run = runGroupProcess("sh", ["-c", `${script} sleep 60 & echo $! > "${pidFile}"; wait`], {
    signal,
    timeout,
    killGraceMs: 200,
  });
  run.catch(() => undefined);
  const pid = await vi.waitFor(async () => {
    const text = (await readFile(pidFile, "utf8")).trim();
    if (text === "") throw new Error("no pid yet");
    return Number(text);
  });
  return { run, pid };
}

it("resolves trimmed stdout and passes extra environment", async () => {
  await expect(
    runGroupProcess("sh", ["-c", 'printf "  $GREETING  \\n"'], {
      signal: new AbortController().signal,
      timeout: 10_000,
      env: { GREETING: "hello" },
    }),
  ).resolves.toBe("hello");
});

it("rejects a failing command with its stderr", async () => {
  await expect(
    runGroupProcess("sh", ["-c", "echo nope >&2; exit 3"], {
      signal: new AbortController().signal,
      timeout: 10_000,
    }),
  ).rejects.toThrow(/exit 3[\s\S]*nope/);
});

it("stops the whole process group on abort", async () => {
  const controller = new AbortController();
  const { run, pid } = await spawnTree(controller.signal, 30_000);
  expect(alive(pid)).toBe(true);
  controller.abort();
  await expect(run).rejects.toThrow();
  await vi.waitFor(() => expect(alive(pid)).toBe(false));
});

it("escalates to SIGKILL when the group ignores SIGTERM past the timeout", async () => {
  const { run, pid } = await spawnTree(new AbortController().signal, 300, "trap '' TERM;");
  await expect(run).rejects.toThrow(/timed out after 300 ms/);
  await vi.waitFor(() => expect(alive(pid)).toBe(false));
});

it("rejects at once when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(
    runGroupProcess("sh", ["-c", "sleep 60"], { signal: controller.signal, timeout: 10_000 }),
  ).rejects.toThrow("cancelled");
});
