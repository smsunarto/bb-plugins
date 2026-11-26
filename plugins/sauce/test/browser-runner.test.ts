import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type ExecFile,
  createAgentBrowserRunner,
  userScopeAvailable,
} from "../src/server/browser.ts";

const paths = { profile: "/profile", headedConfig: "/headed.json" };
const tools: Record<string, string> = {
  "agent-browser": "/bin/agent-browser",
  "systemd-run": "/usr/bin/systemd-run",
};
const resolve = (command: string) => tools[command] ?? null;
const ok = JSON.stringify({ success: true, data: { ok: 1 } });

type Call = { file: string; args: readonly string[]; signal: AbortSignal | undefined };

/** Records each spawn and answers with the scripted replies in order. */
function fakeExec(replies: { stdout?: string; stderr?: string; error?: Error }[]) {
  const calls: Call[] = [];
  const exec: ExecFile = (file, args, options, callback) => {
    calls.push({ file, args, signal: options.signal });
    const reply = replies.shift() ?? { stdout: ok };
    queueMicrotask(() => callback(reply.error ?? null, reply.stdout ?? "", reply.stderr ?? ""));
  };
  return { calls, exec };
}

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("a user scope needs a Linux session bus", () => {
  const none = () => false;
  expect(userScopeAvailable({}, "linux", none)).toBe(false);
  expect(userScopeAvailable({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux", none)).toBe(false);
  expect(
    userScopeAvailable(
      { XDG_RUNTIME_DIR: "/run/user/1000" },
      "linux",
      (p) => p === "/run/user/1000/bus",
    ),
  ).toBe(true);
  expect(userScopeAvailable({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" }, "linux", none)).toBe(
    true,
  );
  expect(userScopeAvailable({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" }, "darwin", none)).toBe(
    false,
  );
});

test("without a session bus agent-browser runs directly, with the caller's signal", async () => {
  const { calls, exec } = fakeExec([{ stdout: ok }]);
  const runner = createAgentBrowserRunner(paths, {
    env: {},
    platform: "linux",
    exists: (p) => p === paths.profile,
    resolve,
    exec,
  });
  const controller = new AbortController();
  expect(await runner.run(["eval", "1"], 1_000, controller.signal)).toEqual({ ok: 1 });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.file).toBe("/bin/agent-browser");
  expect(calls[0]?.signal).toBe(controller.signal);
});

test("a scope systemd-run cannot create falls back to a direct spawn, and stays off", async () => {
  const { calls, exec } = fakeExec([
    { stderr: "Failed to connect to bus: No medium found", error: new Error("exit 1") },
    { stdout: ok },
    { stdout: ok },
  ]);
  const runner = createAgentBrowserRunner(paths, {
    env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/stale" },
    platform: "linux",
    exists: (p) => p === paths.profile,
    resolve,
    exec,
  });
  expect(await runner.run(["eval", "1"])).toEqual({ ok: 1 });
  expect(await runner.run(["eval", "2"])).toEqual({ ok: 1 });
  expect(calls.map(({ file, args }) => [file, args[0]])).toEqual([
    ["/usr/bin/systemd-run", "--user"],
    ["/bin/agent-browser", "--json"],
    ["/bin/agent-browser", "--json"],
  ]);
});

test("an aborted call spawns nothing, and a plugin dispose cancels calls in flight", async () => {
  const { calls, exec } = fakeExec([]);
  const lifetime = new AbortController();
  const runner = createAgentBrowserRunner(paths, {
    signal: lifetime.signal,
    env: {},
    platform: "linux",
    exists: () => true,
    resolve,
    exec,
  });
  const aborted = new AbortController();
  aborted.abort();
  await expect(runner.run(["eval", "1"], 1_000, aborted.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(calls).toHaveLength(0);
  lifetime.abort();
  await expect(runner.run(["eval", "1"])).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toHaveLength(0);
});

test("aborting kills a running agent-browser process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sauce-runner-"));
  cleanup.push(dir);
  const binary = join(dir, "agent-browser");
  await writeFile(binary, `#!/bin/sh\necho $$ > "${dir}/pid"\nexec sleep 30\n`, { mode: 0o755 });
  const runner = createAgentBrowserRunner(
    { profile: dir, headedConfig: join(dir, "headed.json") },
    { env: { PATH: "/usr/bin:/bin" }, platform: "linux", resolve: () => binary },
  );
  const controller = new AbortController();
  const started = Date.now();
  const call = runner.run(["eval", "1"], 20_000, controller.signal);
  for (let i = 0; i < 400 && !existsSync(join(dir, "pid")); i += 1) await sleep(5);
  controller.abort();
  await expect(call).rejects.toMatchObject({ name: "AbortError" });
  expect(Date.now() - started).toBeLessThan(10_000);
  const pid = Number((await readFile(join(dir, "pid"), "utf8")).trim());
  expect(() => process.kill(pid, 0)).toThrow();
});
