import { describe, expect, test } from "bun:test";
import {
  createLocalServerSupervisor,
  isLocalServerCommand,
  LOCAL_SERVER_ARGS,
  type LocalServerChild,
  type LocalServerDeps,
  type LocalServerSignal,
} from "../lib/local-server.ts";

type FakeChild = LocalServerChild & {
  exit(): void;
  killed: boolean;
  signals: LocalServerSignal[];
};

function harness(
  options: {
    busy?: boolean;
    binary?: string | null;
    recorded?: number | null;
    /** Processes ignore SIGTERM, as a hung server does. */
    ignoreTerm?: boolean;
  } = {},
) {
  let busy = options.busy ?? false;
  let clock = 0;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  const children: FakeChild[] = [];
  const commands = new Map<number, string>();
  const killedPids: number[] = [];
  const pidSignals: Array<[number, LocalServerSignal]> = [];
  let recorded: number | null = options.recorded ?? null;
  let leases = 0;
  let nextPid = 100;

  const deps: LocalServerDeps = {
    portBusy: async () => busy,
    findBinary: async () => (options.binary === undefined ? "/bin/agentation-mcp" : options.binary),
    spawn(binary, args) {
      const pid = nextPid++;
      let resolveExit = () => {};
      const exited = new Promise<void>((resolve) => (resolveExit = resolve));
      commands.set(pid, `node ${binary} ${args.join(" ")}`);
      const child: FakeChild = {
        pid,
        exited,
        killed: false,
        signals: [],
        kill(signal = "SIGTERM") {
          child.signals.push(signal);
          if (signal === "SIGTERM" && options.ignoreTerm) return;
          child.killed = true;
          child.exit();
        },
        exit() {
          if (!commands.has(pid)) return;
          commands.delete(pid);
          busy = false;
          resolveExit();
        },
      };
      busy = true;
      children.push(child);
      return child;
    },
    logTail: async () => "EADDRINUSE",
    readRecordedPid: async () => recorded,
    recordPid: async (pid) => {
      recorded = pid;
    },
    commandOf: async (pid) => commands.get(pid) ?? null,
    killPid(pid, signal = "SIGTERM") {
      pidSignals.push([pid, signal]);
      if (signal === "SIGTERM" && options.ignoreTerm) return;
      killedPids.push(pid);
      commands.delete(pid);
      busy = false;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    setTimer(run, ms) {
      const timer = { at: clock + ms, run, live: true };
      timers.push(timer);
      return () => (timer.live = false);
    },
    log: () => {},
  };

  const supervisor = createLocalServerSupervisor(deps);
  const retain = () => {
    leases++;
    return {
      dispose: async () => {
        leases--;
      },
    };
  };

  return {
    supervisor,
    retain,
    children,
    commands,
    killedPids,
    pidSignals,
    clock: () => clock,
    leases: () => leases,
    recorded: () => recorded,
    setBusy: (value: boolean) => (busy = value),
    /** Run timers due within `ms`, then let their promises settle. */
    async advance(ms: number) {
      clock += ms;
      for (const timer of timers.filter((each) => each.live && each.at <= clock)) {
        timer.live = false;
        timer.run();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

describe("shared Agentation server supervisor", () => {
  test("starts agentation-mcp on loopback port 4747 and keeps the worker", async () => {
    const h = harness();
    const result = await h.supervisor.ensure(true, h.retain);
    expect(result).toEqual({ state: "running", pid: 100, message: null });
    expect(h.commands.get(100)).toBe(`node /bin/agentation-mcp ${LOCAL_SERVER_ARGS.join(" ")}`);
    expect(LOCAL_SERVER_ARGS).toContain("127.0.0.1");
    expect(h.leases()).toBe(1);
    expect(h.recorded()).toBe(100);
  });

  test("repeated ensure calls start one server", async () => {
    const h = harness();
    await Promise.all([h.supervisor.ensure(true, h.retain), h.supervisor.ensure(true, h.retain)]);
    await h.supervisor.ensure(true, h.retain);
    expect(h.children).toHaveLength(1);
    expect(h.leases()).toBe(1);
  });

  test("leaves a port another process serves alone, and takes over once it is free", async () => {
    const h = harness({ busy: true });
    expect((await h.supervisor.ensure(true, h.retain)).state).toBe("external");
    expect(h.children).toHaveLength(0);
    h.setBusy(false);
    await h.advance(60_000);
    await h.settle();
    expect(h.children).toHaveLength(1);
    expect(h.supervisor.current().state).toBe("running");
  });

  test("reports a missing CLI without holding the worker", async () => {
    const h = harness({ binary: null });
    const result = await h.supervisor.ensure(true, h.retain);
    expect(result.state).toBe("missing");
    expect(h.leases()).toBe(0);
  });

  test("restarts after a crash and gives up after five in ten minutes", async () => {
    const h = harness();
    await h.supervisor.ensure(true, h.retain);
    for (let crash = 1; crash <= 5; crash++) {
      h.children.at(-1)?.exit();
      await h.settle();
      await h.advance(2000 * crash);
      await h.settle();
      expect(h.children).toHaveLength(crash + 1);
    }
    h.children.at(-1)?.exit();
    await h.settle();
    await h.settle();
    expect(h.supervisor.current().state).toBe("failed");
    expect(h.leases()).toBe(0);
  });

  test("turning the setting off stops the server and releases the worker", async () => {
    const h = harness();
    await h.supervisor.ensure(true, h.retain);
    const result = await h.supervisor.ensure(false, h.retain);
    expect(result.state).toBe("stopped");
    expect(h.children[0]?.killed).toBe(true);
    expect(h.leases()).toBe(0);
    expect(h.recorded()).toBeNull();
  });

  test("stopping a server that ignores SIGTERM escalates to SIGKILL within the grace period", async () => {
    const h = harness({ ignoreTerm: true });
    await h.supervisor.ensure(true, h.retain);
    const before = h.clock();
    const result = await h.supervisor.ensure(false, h.retain);
    expect(result.state).toBe("stopped");
    expect(h.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.clock() - before).toBeGreaterThanOrEqual(2000);
    expect(h.clock() - before).toBeLessThan(3000);
    expect(h.recorded()).toBeNull();
    expect(h.leases()).toBe(0);
  });

  test("a server that survives SIGKILL does not stall the stop", async () => {
    const h = harness({ ignoreTerm: true });
    await h.supervisor.ensure(true, h.retain);
    const child = h.children[0]!;
    child.kill = (signal = "SIGTERM") => void child.signals.push(signal);
    const before = h.clock();
    expect((await h.supervisor.ensure(false, h.retain)).state).toBe("stopped");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.clock() - before).toBeLessThanOrEqual(3100);
  });

  test("a clean exit on SIGTERM is not killed", async () => {
    const h = harness();
    await h.supervisor.ensure(true, h.retain);
    await h.supervisor.ensure(false, h.retain);
    expect(h.children[0]?.signals).toEqual(["SIGTERM"]);
  });

  test("an adopted server that ignores SIGTERM is killed by PID", async () => {
    const h = harness({ busy: true, recorded: 77, ignoreTerm: true });
    h.commands.set(77, `node /bin/agentation-mcp ${LOCAL_SERVER_ARGS.join(" ")}`);
    expect((await h.supervisor.ensure(true, h.retain)).pid).toBe(77);
    await h.supervisor.ensure(false, h.retain);
    expect(h.pidSignals).toEqual([
      [77, "SIGTERM"],
      [77, "SIGKILL"],
    ]);
  });

  test("disposing the worker escalates and settles", async () => {
    const h = harness({ ignoreTerm: true });
    await h.supervisor.ensure(true, h.retain);
    await h.supervisor.dispose();
    expect(h.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.recorded()).toBeNull();
    expect(h.leases()).toBe(0);
  });

  test("adopts the server an earlier worker started, and can stop it", async () => {
    const first = harness();
    await first.supervisor.ensure(true, first.retain);
    const pid = first.children[0]!.pid;

    const h = harness({ busy: true, recorded: pid });
    h.commands.set(pid, first.commands.get(pid)!);
    const result = await h.supervisor.ensure(true, h.retain);
    expect(result.state).toBe("running");
    expect(result.pid).toBe(pid);
    expect(h.children).toHaveLength(0);

    await h.supervisor.ensure(false, h.retain);
    expect(h.killedPids).toEqual([pid]);
  });

  test("does not adopt a recorded PID that now belongs to another program", async () => {
    const h = harness({ busy: true, recorded: 42 });
    h.commands.set(42, "/usr/bin/vim notes.md");
    expect((await h.supervisor.ensure(true, h.retain)).state).toBe("external");
    expect(h.recorded()).toBeNull();
  });

  test("recognizes its own server command lines only", () => {
    expect(
      isLocalServerCommand(
        "node /home/me/.bun/bin/agentation-mcp server --port 4747 --host 127.0.0.1",
      ),
    ).toBe(true);
    expect(
      isLocalServerCommand(
        "node agentation-mcp server --mcp-only --http-url http://localhost:4747",
      ),
    ).toBe(false);
  });
});
