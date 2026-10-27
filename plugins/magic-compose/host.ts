// Runs on every enrolled machine's daemon. BB's machine record carries no
// operating system or load, so the server asks each machine directly.
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import { parseVmStatAvailableBytes } from "./lib/vm-stat.js";

const run = promisify(execFile);

// os.freemem() on macOS counts only wired-free pages, so a healthy Mac reads
// as nearly full. vm_stat also reports the reclaimable pages.
async function freeMemoryBytes(signal: AbortSignal): Promise<number> {
  if (os.platform() === "darwin") {
    try {
      const { stdout } = await run("vm_stat", [], { signal, timeout: 2_000 });
      const available = parseVmStatAvailableBytes(stdout);
      if (available !== null) return Math.min(available, os.totalmem());
    } catch {
      // Fall back to the kernel's own number.
    }
  }
  return os.freemem();
}

async function diskSpace(): Promise<{ total: number; free: number } | null> {
  try {
    const stats = await statfs(os.homedir());
    return { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    stats: async (_input, context) => {
      const [memoryFreeBytes, disk] = await Promise.all([
        freeMemoryBytes(context.signal),
        diskSpace(),
      ]);
      return {
        platform: os.platform(),
        arch: os.arch(),
        osRelease: os.release(),
        cpuCount: os.cpus().length,
        // Windows has no load average; Node reports zeros there.
        loadAverage1m: os.platform() === "win32" ? null : (os.loadavg()[0] ?? null),
        memoryTotalBytes: os.totalmem(),
        memoryFreeBytes,
        diskTotalBytes: disk?.total ?? null,
        diskFreeBytes: disk?.free ?? null,
      };
    },
  },
});
