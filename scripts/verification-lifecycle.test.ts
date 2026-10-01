import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const control = join(import.meta.dir, "../.agents/skills/verify-bb-plugins/scripts/control");

for (const failure of [
  "none",
  "runtime",
  "browser",
  "signal",
  "hangup",
  "pipe",
  "quit",
  "start",
  "existing",
] as const) {
  const signals: Partial<Record<typeof failure, NodeJS.Signals>> = {
    signal: "SIGTERM",
    hangup: "SIGHUP",
    pipe: "SIGPIPE",
    quit: "SIGQUIT",
  };
  const signal = signals[failure];
  const expectedExit = {
    none: 1,
    runtime: 1,
    browser: 1,
    signal: 143,
    hangup: 129,
    pipe: 141,
    quit: 131,
    start: 17,
    existing: 1,
  }[failure];
  const cleanupStatus = failure === "runtime" ? "23" : "0";
  const browserStatus = failure === "browser" ? "24" : "0";
  const interruptLaunch = signal ? "1" : "0";
  const failStart = failure === "start" ? "1" : "0";
  const existingRuntime = failure === "existing" ? "1" : "0";
  test(`failed verification launch cleans up (${failure})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "verification-lifecycle-"));
    const calls = join(directory, "calls");
    const runDirectory = join(import.meta.dir, "../.scratch/verify-bb-plugins/runs/lifecycle-test");
    try {
      await mkdir(runDirectory, { recursive: true });
      await writeFile(join(runDirectory, "run.env"), "existing ready marker");
      // Run the real launcher with a dev-instance CLI that fails after creating
      // the isolated runtime. JSON parsing still runs in the real Bun runtime.
      await writeFile(
        join(directory, "bun"),
        `#!/usr/bin/env bash
if [[ "$1" == "-e" ]]; then exec "$REAL_BUN" "$@"; fi
printf '%s\\n' "$*" >> "$CALLS"
case "$3" in
  status)
    if [[ "$EXISTING_RUNTIME" == "1" ]]; then
      printf '%s\\n' '{"ok":true,"result":{"phase":"running"}}'
    else
      printf '%s\\n' '{"ok":true,"result":{"phase":"absent"}}'
    fi
    ;;
  start)
    if [[ "$FAIL_START" == "1" && " $* " == *" --name "* ]]; then
      printf '%s\\n' '{"ok":false,"error":{"message":"fixture preparation failed"}}'
      exit 17
    fi
    printf '%s\\n' '{"ok":true,"result":{"name":"workspace-owner","revision":"test-revision","dataDir":"/does-not-exist"}}'
    ;;
  workspace)
    if [[ " $* " == *" --name "* ]]; then
      if [[ "$INTERRUPT_LAUNCH" == "1" ]]; then sleep 2; fi
      printf '%s\\n' '{"ok":false,"error":{"message":"fixture preparation failed"}}'
      exit 17
    fi
    printf '%s\\n' '{"ok":true,"result":{}}'
    ;;
  destroy) exit "$CLEANUP_STATUS" ;;
  *) exit 99 ;;
esac
`,
      );
      await writeFile(
        join(directory, "agent-browser"),
        '#!/usr/bin/env bash\nexit "$BROWSER_STATUS"\n',
      );
      await chmod(join(directory, "bun"), 0o755);
      await chmod(join(directory, "agent-browser"), 0o755);
      const child = Bun.spawn(["bash", control, "launch", "lifecycle-test"], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          REAL_BUN: process.execPath,
          CALLS: calls,
          CLEANUP_STATUS: cleanupStatus,
          BROWSER_STATUS: browserStatus,
          INTERRUPT_LAUNCH: interruptLaunch,
          FAIL_START: failStart,
          EXISTING_RUNTIME: existingRuntime,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (signal) {
        const deadline = Date.now() + 5_000;
        while (!(await readFile(calls, "utf8").catch(() => "")).includes("workspace --name")) {
          if (Date.now() > deadline) {
            child.kill();
            throw new Error("launcher did not reach isolated runtime preparation");
          }
          await Bun.sleep(25);
        }
        child.kill(signal);
      }
      const [exit, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect(exit).toBe(expectedExit);
      if (failure === "existing") {
        expect(stderr).toContain("run ID is in use: lifecycle-test");
        expect(await readFile(join(runDirectory, "run.env"), "utf8")).toBe("existing ready marker");
      } else {
        expect(stderr).toContain("fixture preparation failed");
        expect(await readFile(join(runDirectory, "run.env"), "utf8").catch(() => null)).toBeNull();
      }
      const destroyed = (await readFile(calls, "utf8"))
        .split("\n")
        .filter((line) => line.includes(" dev-instance destroy "))
        .map((line) => line.slice(line.indexOf(" dev-instance destroy ") + 1));
      expect(destroyed).toEqual(
        failure === "existing" ? [] : ["dev-instance destroy verify-lifecycle-test --timeout 300"],
      );
      if (failure === "runtime" || failure === "browser") {
        expect(stderr).toContain("cleanup failed for lifecycle-test");
      }
      if (failure === "browser") {
        expect(stderr).toContain("could not close browser verify-bb-plugins-lifecycle-test");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(runDirectory, { recursive: true, force: true });
    }
  });
}
