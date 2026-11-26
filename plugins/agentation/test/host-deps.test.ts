import { afterEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostDeps, openLogFile, readLogTail, readPidFile, writePidFile } from "../host.ts";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentation-host-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agentation host effects", () => {
  test("opening the log creates a missing data directory", () => {
    const dataDir = join(scratch(), "nested", "data");
    const fd = openLogFile(join(dataDir, "agentation-server.log"));
    expect(typeof fd).toBe("number");
    closeSync(fd);
    expect(existsSync(join(dataDir, "agentation-server.log"))).toBe(true);
  });

  test("the log tail reads only the last bytes of a large log", async () => {
    const path = join(scratch(), "agentation-server.log");
    const head = "x".repeat(8 * 1024 * 1024);
    writeFileSync(path, `${head}\nlast line: EADDRINUSE\n`);
    const tail = await readLogTail(path, 1500);
    expect(tail.length).toBeLessThanOrEqual(1500);
    expect(tail.endsWith("last line: EADDRINUSE")).toBe(true);
  });

  test("the log tail drops a multi-byte character the cut splits", async () => {
    const path = join(scratch(), "agentation-server.log");
    writeFileSync(path, "ééééé");
    expect(await readLogTail(path, 3)).toBe("é");
    expect(await readLogTail(join(scratch(), "missing.log"), 3)).toBe("");
  });

  test("the PID file is replaced atomically and leaves no temp file", async () => {
    const dir = scratch();
    const path = join(dir, "agentation-server.pid");
    await writePidFile(path, 123);
    await writePidFile(path, 4567);
    expect(readFileSync(path, "utf8")).toBe("4567");
    expect(readdirSync(dir)).toEqual(["agentation-server.pid"]);
    expect(await readPidFile(path)).toBe(4567);
    await writePidFile(path, null);
    expect(existsSync(path)).toBe(false);
    expect(await readPidFile(path)).toBeNull();
  });

  test("a failed PID write leaves the old file and no temp file", async () => {
    const dir = scratch();
    const path = join(dir, "missing-dir", "agentation-server.pid");
    await expect(writePidFile(path, 1)).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "a spawned server that ignores SIGTERM exits on SIGKILL",
    async () => {
      const dataDir = join(scratch(), "fresh");
      const deps = createHostDeps(() => dataDir);
      const child = deps.spawn("/bin/sh", ["-c", `trap '' TERM; echo ready; exec sleep 30`]);
      expect(child.pid).toBeGreaterThan(0);
      let exited = false;
      void child.exited.then(() => (exited = true));
      await deps.sleep(200);
      child.kill("SIGTERM");
      await deps.sleep(200);
      expect(exited).toBe(false);
      child.kill("SIGKILL");
      await child.exited;
      expect(exited).toBe(true);
      expect(await deps.logTail()).toBe("ready");
    },
  );
});
