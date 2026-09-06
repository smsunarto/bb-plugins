import { afterEach, expect, mock, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorManager, probe, supervisorSource } from "./connector.ts";

const connectorId = "b37c2b41-89e7-4110-b60e-bc80aa2377d5";
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for subprocess state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fakeExecutable() {
  const directory = mkdtempSync(join(tmpdir(), "cloudflare-host-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const executable = join(directory, "cloudflared fake; literal");
  const record = join(directory, "spawn.json");
  const exited = join(directory, "exited");
  const emitConnector = join(directory, "emit-connector");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') process.exit(0);
process.on('SIGTERM', () => setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(exited)}, 'terminated');
  process.exit(0);
}, 80));
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  pid: process.pid, argv: process.argv.slice(2), token: process.env.TUNNEL_TOKEN,
}));
if (process.argv.includes('--url')) setTimeout(() => {
  process.stderr.write('INF +--------------------------------------------------------------+\\n');
  process.stderr.write('INF |  Your quick Tunnel has been created! Visit it at:            |\\n');
  process.stderr.write('INF |  https://Brave-Otter-Quick.trycloudflare.com                 |\\n');
  process.stderr.write('INF +--------------------------------------------------------------+\\n');
}, 30);
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(emitConnector)})) {
    process.stderr.write('sensitive log ' + process.env.TUNNEL_TOKEN + '\\n');
    process.stderr.write('Generated Connector ID: ${connectorId}\\n');
    clearInterval(timer);
    setInterval(() => {}, 1000);
  }
}, 10);
`,
    { mode: 0o700 },
  );
  return {
    executable,
    exited,
    emitConnector,
    async started() {
      await eventually(() => existsSync(record));
      return JSON.parse(readFileSync(record, "utf8")) as {
        pid: number;
        argv: string[];
        token: string;
      };
    },
  };
}

function managerWithLease() {
  const manager = new ConnectorManager();
  cleanups.push(() => manager.dispose());
  const release = mock(async () => {});
  const retain = mock(() => ({ dispose: release }));
  return { manager, retain, release };
}

test("launches with token only in the environment and exposes only sanitized local status", async () => {
  const executable = fakeExecutable();
  const { manager, retain, release } = managerWithLease();
  const token = "dummy-secret-never-returned";

  expect(await manager.start("share", token, executable.executable, retain)).toEqual({
    running: true,
  });
  const child = await executable.started();
  expect(child.argv).toEqual(["tunnel", "--no-autoupdate", "run"]);
  expect(child.token).toBe(token);
  expect(alive(child.pid)).toBe(true);
  expect(release).not.toHaveBeenCalled();

  writeFileSync(executable.emitConnector, "ready");
  await eventually(() => manager.status("share").connectorId === connectorId);
  expect(manager.status("share")).toEqual({ running: true, connectorId });
  expect(JSON.stringify(manager.status("share"))).not.toContain(token);
  expect(manager.status("share")).not.toHaveProperty("connected");
  expect(manager.status("share")).not.toHaveProperty("healthy");

  await manager.start("share", token, executable.executable, retain);
  expect(retain).toHaveBeenCalledTimes(1);
});

test("quick tunnels pass the origin URL, carry no token and resolve with the assigned hostname", async () => {
  const executable = fakeExecutable();
  const { manager, retain } = managerWithLease();
  const status = await manager.startQuick("quick", 3000, executable.executable, retain);
  expect(status).toEqual({ running: true, url: "https://brave-otter-quick.trycloudflare.com" });
  const child = await executable.started();
  expect(child.argv).toEqual(["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:3000"]);
  expect(child.token).toBeUndefined();
  expect(manager.status("quick").url).toBe("https://brave-otter-quick.trycloudflare.com");
  writeFileSync(executable.emitConnector, "ready");
  await eventually(() => manager.status("quick").connectorId === connectorId);
  await manager.stop("quick");
  expect(manager.status("quick")).toEqual({ running: false });
  expect(retain).toHaveBeenCalledTimes(1);
});

test("stop waits for actual child termination and lease release exactly once", async () => {
  const executable = fakeExecutable();
  const { manager, retain, release } = managerWithLease();
  let released = false;
  release.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    released = true;
  });
  await manager.start("share", "dummy", executable.executable, retain);
  const child = await executable.started();

  const stopped = manager.stop("share");
  expect(alive(child.pid)).toBe(true);
  expect(released).toBe(false);
  expect(await stopped).toEqual({ running: false });
  expect(existsSync(executable.exited)).toBe(true);
  expect(alive(child.pid)).toBe(false);
  expect(released).toBe(true);
  expect(manager.status("share")).toEqual({ running: false });
  await manager.stop("share");
  await manager.dispose();
  expect(release).toHaveBeenCalledTimes(1);
});

test("dispose waits for every subprocess and releases each retained worker", async () => {
  const first = fakeExecutable();
  const second = fakeExecutable();
  const { manager, retain, release } = managerWithLease();
  await manager.start("first", "dummy", first.executable, retain);
  await manager.start("second", "dummy", second.executable, retain);
  const children = await Promise.all([first.started(), second.started()]);

  await manager.dispose();
  expect(children.map((child) => alive(child.pid))).toEqual([false, false]);
  expect(existsSync(first.exited)).toBe(true);
  expect(existsSync(second.exited)).toBe(true);
  expect(manager.status("first")).toEqual({ running: false });
  expect(manager.status("second")).toEqual({ running: false });
  expect(release).toHaveBeenCalledTimes(2);
});

test("missing executable releases the lease and permits a later successful start", async () => {
  const executable = fakeExecutable();
  const { manager, retain, release } = managerWithLease();
  await expect(
    manager.start("share", "dummy-secret", `${executable.executable}-missing`, retain),
  ).rejects.toThrow("cloudflared");
  expect(manager.status("share")).toEqual({ running: false });
  expect(release).toHaveBeenCalledTimes(1);

  await manager.start("share", "dummy", executable.executable, retain);
  await executable.started();
  expect(retain).toHaveBeenCalledTimes(2);
  await manager.stop("share");
  expect(release).toHaveBeenCalledTimes(2);
});

test("unexpected subprocess exit clears local status and releases its worker lease", async () => {
  const executable = fakeExecutable();
  const { manager, retain, release } = managerWithLease();
  await manager.start("share", "dummy", executable.executable, retain);
  const child = await executable.started();
  writeFileSync(executable.emitConnector, "ready");
  await eventually(() => manager.status("share").connectorId === connectorId);

  process.kill(child.pid, "SIGKILL");
  await eventually(() => !manager.status("share").running && release.mock.calls.length === 1);
  expect(alive(child.pid)).toBe(false);
  expect(manager.status("share")).toEqual({ running: false });
  await manager.stop("share");
  expect(release).toHaveBeenCalledTimes(1);
});

test("supervisor terminates its subprocess when the parent's IPC channel disconnects", async () => {
  const executable = fakeExecutable();
  const supervisor = spawn(process.execPath, ["-e", supervisorSource, executable.executable], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = once(supervisor, "exit");
  cleanups.push(async () => {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill("SIGTERM");
      await exited;
    }
  });
  const child = await executable.started();
  supervisor.disconnect();
  await exited;
  expect(existsSync(executable.exited)).toBe(true);
  expect(alive(child.pid)).toBe(false);
});

test("probe requires an executable and accepts an HTTP response without following redirects", async () => {
  const executable = fakeExecutable();
  const server = createServer((_request, response) => {
    response.writeHead(302, { Location: "http://127.0.0.1:1/unreachable" });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port.");

  expect(await probe(address.port, executable.executable)).toMatchObject({
    available: true,
    originReachable: true,
  });
  expect(await probe(address.port, `${executable.executable}-missing`)).toMatchObject({
    available: false,
    originReachable: false,
    message: expect.stringContaining("Install cloudflared"),
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(await probe(address.port, executable.executable)).toMatchObject({
    available: true,
    originReachable: false,
  });
});
