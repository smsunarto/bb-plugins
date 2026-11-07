import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { RETIRE_DAEMON_UNITS } from "./machine.ts";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A home holding a snapshot's daemon unit and lock, with a `systemctl` stub that logs its calls.
 * `STUB_NO_BUS` makes the user bus unreachable; `STUB_FAIL` fails the named subcommand.
 */
async function snapshotHome(units: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "boat-retire-"));
  roots.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const unitDir = path.join(home, ".config", "systemd", "user");
  const dataDir = path.join(home, ".bb-machines", "scott.getbb.app");
  await mkdir(unitDir, { recursive: true });
  await mkdir(path.join(dataDir, "daemon.lock.lock"), { recursive: true });
  await writeFile(path.join(dataDir, "host-id"), "host_old\n");
  await mkdir(bin);
  for (const unit of units) await writeFile(path.join(unitDir, unit), "[Service]\n");
  const log = path.join(root, "systemctl.log");
  await writeFile(
    path.join(bin, "systemctl"),
    [
      "#!/bin/sh",
      '[ "$2" = show-environment ] && { [ -z "$STUB_NO_BUS" ]; exit; }',
      `echo "$*" >> '${log}'`,
      '[ "$2" != "$STUB_FAIL" ]',
    ].join("\n"),
  );
  // No loginctl: the stub bus answers or it does not.
  await writeFile(path.join(bin, "loginctl"), "#!/bin/sh\nexit 1\n");
  await chmod(path.join(bin, "loginctl"), 0o755);
  await chmod(path.join(bin, "systemctl"), 0o755);
  const run = (env: Record<string, string> = {}) =>
    exec("sh", ["-c", RETIRE_DAEMON_UNITS], {
      env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
    });
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n");
  return { unitDir, dataDir, run, calls };
}

test("stops and deletes a snapshot's daemon unit and clears its lock", async () => {
  const home = await snapshotHome(["bb-host-daemon-scott-getbb-app-host_old.service"]);
  const { stdout } = await home.run();
  expect(stdout).toContain("bb-host-daemon-scott-getbb-app-host_old.service");
  expect(await home.calls()).toEqual([
    "--user disable --now bb-host-daemon-scott-getbb-app-host_old.service",
    "--user daemon-reload",
  ]);
  expect(await readdir(home.unitDir)).toEqual([]);
  await expect(stat(path.join(home.dataDir, "daemon.lock.lock"))).rejects.toThrow();
  // Setup rewrites the identity; the script leaves the rest of the data dir alone.
  expect(await readFile(path.join(home.dataDir, "host-id"), "utf8")).toBe("host_old\n");
});

test("leaves a machine without daemon units untouched", async () => {
  const home = await snapshotHome([]);
  await home.run();
  expect(await home.calls()).toEqual([""]);
  expect((await stat(path.join(home.dataDir, "daemon.lock.lock"))).isDirectory()).toBe(true);
});

test("leaves the unit alone when there is no systemd user bus to stop it with", async () => {
  const home = await snapshotHome(["bb-host-daemon-scott-getbb-app-host_old.service"]);
  await home.run({ STUB_NO_BUS: "1" });
  expect(await home.calls()).toEqual([""]);
  expect(await readdir(home.unitDir)).toEqual(["bb-host-daemon-scott-getbb-app-host_old.service"]);
});

test("fails and keeps the unit when systemd cannot stop it", async () => {
  const home = await snapshotHome(["bb-host-daemon-scott-getbb-app-host_old.service"]);
  await expect(home.run({ STUB_FAIL: "disable" })).rejects.toMatchObject({ code: 1 });
  expect(await readdir(home.unitDir)).toEqual(["bb-host-daemon-scott-getbb-app-host_old.service"]);
});
