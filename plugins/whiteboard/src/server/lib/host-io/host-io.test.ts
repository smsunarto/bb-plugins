import { writeFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalVcsToolsMissingError } from "../../../shared/node/vendor/local-vcs/src/index.ts";
import { ReviewInputError } from "../../../shared/vendor/review/src/review-api/input-error.ts";
import { encodeArgs, fromWireError, hostIo, installHostIo, invokeHost } from "./client.ts";
import { watch } from "./fs.ts";
import * as hostFs from "./fs.ts";
import { forgetProbes, lastProbedDiffr, probeHost } from "./probe.ts";
import { type GitFixture, gitFixture } from "./testing/git-fixture.ts";
import {
  IN_PROCESS_HOST_ID,
  type InProcessHostClient,
  createInProcessHostClient,
  inProcessResolver,
  installInProcessHostIo,
} from "./testing/in-process.ts";

let repo: GitFixture;

beforeAll(() => {
  repo = gitFixture();
});

afterAll(() => {
  repo.remove();
});

describe("hop errors", () => {
  it("rebuild upstream classes, statuses and errno codes", () => {
    const missing = fromWireError({
      name: "ReviewInputError",
      message: "No such review.",
      status: 404,
    });
    expect(missing).toBeInstanceOf(ReviewInputError);
    expect(missing).toMatchObject({ message: "No such review.", status: 404 });

    const tools = fromWireError({ name: "LocalVcsToolsMissingError", message: "git is missing" });
    expect(tools).toBeInstanceOf(LocalVcsToolsMissingError);
    expect(tools.message).toBe("git is missing");

    expect(fromWireError({ name: "Error", message: "ENOENT: x", code: "ENOENT" })).toMatchObject({
      name: "Error",
      message: "ENOENT: x",
      code: "ENOENT",
    });
  });

  it("a host result above the limit arrives as PayloadTooLarge", async () => {
    const { uninstall } = installInProcessHostIo();
    try {
      const file = `${repo.root}/six-mib.bin`;
      writeFileSync(file, Buffer.alloc(6 * 1024 * 1024, 1));
      await expect(hostFs.readFile(file)).rejects.toMatchObject({ name: "PayloadTooLarge" });
      expect(() => encodeArgs(["x".repeat(8 * 1024 * 1024)])).toThrow(
        "whiteboard: the host call input is 8388612 bytes, above the 7340032-byte host transfer limit.",
      );
    } finally {
      uninstall();
      repo.git("clean", "-fdqx");
    }
  });
});

describe("probeHost", () => {
  it("probes once per host and records the diffr it found", async () => {
    const { client, uninstall } = installInProcessHostIo();
    try {
      vi.stubEnv("REVIEW_DIFFR_BINARY", "/bin/echo");
      forgetProbes();
      const first = await probeHost(IN_PROCESS_HOST_ID);
      expect(first).toMatchObject({ platform: process.platform, git: true, diffr: "/bin/echo" });
      expect(lastProbedDiffr()).toBe("/bin/echo");
      expect(await probeHost(IN_PROCESS_HOST_ID)).toBe(first);
      expect(client.calls.filter((call) => call.method === "probe").length).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      forgetProbes();
      uninstall();
    }
  });
});

describe("watch over host signals", () => {
  let client: InProcessHostClient;
  let uninstall: () => void;

  beforeAll(() => {
    ({ client, uninstall } = installInProcessHostIo());
  });

  afterAll(() => uninstall());

  it("fires on a file write, re-arms after a worker exit, and stops on close", async () => {
    const events: string[] = [];
    const watcher = watch(repo.root, { recursive: true }, (event) => void events.push(event));
    const armed = () => client.calls.filter((call) => call.method === "watchWorktree").length;
    await expect.poll(armed).toBe(1);
    // A recorded arm may not be watching yet, so write until a change arrives.
    // Writes are spaced past the 75 ms debounce, or they would keep resetting it.
    let writes = 0;
    let lastWrite = 0;
    const writeUntilChanged = () => {
      if (events.includes("change")) return true;
      if (Date.now() - lastWrite > 300) {
        lastWrite = Date.now();
        writeFileSync(`${repo.root}/src/a.ts`, `export const a = ${100 + writes++};\n`);
      }
      return false;
    };

    await expect.poll(writeUntilChanged, { timeout: 5_000 }).toBe(true);

    await client.simulateWorkerExit();
    // Changes made while no worker watched are unknown: one "rename" notice, then a fresh watch.
    expect(events.at(-1)).toBe("rename");
    await expect.poll(armed).toBe(2);
    events.length = 0;
    lastWrite = 0;
    await expect.poll(writeUntilChanged, { timeout: 5_000 }).toBe(true);

    let closed = false;
    watcher.on("close", () => (closed = true));
    watcher.close();
    expect(closed).toBe(true);
    await expect
      .poll(() => client.calls.filter((call) => call.method === "unwatchWorktree").length)
      .toBe(1);
    events.length = 0;
    writeFileSync(`${repo.root}/src/a.ts`, "export const a = 102;\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events).toEqual([]);
    repo.git("checkout", "--", "src/a.ts");
  });
});

describe("watch closed while its arm is in flight", () => {
  it("leaves no watch on the host", async () => {
    const { client, uninstall } = installInProcessHostIo();
    const seen: string[] = [];
    const off = client.experimental_onSignal("worktreeChanged", (event) => {
      seen.push(event.payload.watchId);
    });
    const call = client.call.bind(client);
    let watcher: ReturnType<typeof watch> | undefined;
    // Close as soon as the arm is sent, before the host has registered it.
    client.call = ((method, input, options) => {
      const pending = call(method, input, options);
      if (method === "watchWorktree") queueMicrotask(() => watcher!.close());
      return pending;
    }) as typeof client.call;
    try {
      watcher = watch(repo.root, undefined, () => {});
      await expect
        .poll(() => client.calls.filter((entry) => entry.method === "watchWorktree").length)
        .toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      writeFileSync(`${repo.root}/src/a.ts`, "export const a = 103;\n");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(seen).toEqual([]);
    } finally {
      off();
      uninstall();
      await client.simulateWorkerExit();
      repo.git("checkout", "--", "src/a.ts");
    }
  });
});

describe("installHostIo through bb.hosts", () => {
  it("routes calls, signals and worker exits through the bb host client", async () => {
    const host = createInProcessHostClient();
    const { bb, harness } = createFakePluginHost({
      pluginId: "whiteboard",
      experimental_callHostRpc: (call) =>
        host.call(call.method as never, call.input as never, { hostId: call.hostId }),
    });
    const uninstall = installHostIo(bb, inProcessResolver());
    const wired = hostIo().client;
    try {
      expect(await invokeHost("local-vcs", "gitCommonDir", [repo.root], {})).toBe(
        `${repo.root}/.git`,
      );
      const events: string[] = [];
      const watcher = watch(repo.root, undefined, (event) => void events.push(event));
      const rpc = () => harness.inspection.experimental_hostRpcCalls;
      await expect
        .poll(() => rpc().filter((call) => call.method === "watchWorktree").length)
        .toBe(1);
      const watchId = (
        rpc().find((call) => call.method === "watchWorktree")!.input as {
          watchId: string;
        }
      ).watchId;

      await expect.poll(() => events.includes("rename")).toBe(true);
      events.length = 0;
      await harness.behavior.experimental_emitHostSignal(IN_PROCESS_HOST_ID, "worktreeChanged", {
        watchId,
        rootPath: repo.root,
        kind: "changed",
      });
      // Another watch's signal, or another host's, is not ours.
      await harness.behavior.experimental_emitHostSignal("other-host", "worktreeChanged", {
        watchId,
        rootPath: repo.root,
        kind: "changed",
      });
      expect(events).toEqual(["change"]);

      await harness.behavior.experimental_emitHostWorkerExit(IN_PROCESS_HOST_ID);
      expect(events).toEqual(["change", "rename"]);
      await expect
        .poll(() => rpc().filter((call) => call.method === "watchWorktree").length)
        .toBe(2);

      const errors: Error[] = [];
      watcher.on("error", (error) => errors.push(error));
      await harness.behavior.experimental_emitHostSignal(IN_PROCESS_HOST_ID, "worktreeChanged", {
        watchId,
        rootPath: repo.root,
        kind: "watch-error",
      });
      expect(errors.map((error) => error.message)).toEqual([
        `whiteboard: the host stopped watching ${repo.root}.`,
      ]);
      watcher.close();
    } finally {
      uninstall();
    }
    // The uninstall restores whatever was installed before (nothing, or a spec setup's host).
    const restored = (() => {
      try {
        return hostIo().client;
      } catch {
        return undefined;
      }
    })();
    expect(restored).not.toBe(wired);
    await host.simulateWorkerExit();
  });
});
