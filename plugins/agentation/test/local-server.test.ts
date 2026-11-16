import { describe, expect, test } from "bun:test";
import {
  createLocalServerSupervisor,
  isLocalServerCommand,
  LOCAL_SERVER_ARGS,
  type LocalServerChild,
  type LocalServerDeps,
} from "../lib/local-server.ts";

type FakeChild = LocalServerChild & { exit(): void; killed: boolean };

function harness(
  options: { busy?: boolean; binary?: string | null; recorded?: number | null } = {},
) {
  let busy = options.busy ?? false;
  let clock = 0;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  const children: FakeChild[] = [];
  const commands = new Map<number, string>();
  const killedPids: number[] = [];
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
        kill() {
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
    killPid(pid) {
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
