import { describe, expect, test } from "vitest";
import type { AdoptOptions, AdoptResult } from "../contract/rpc.ts";
import { captainHost, newCaptain } from "./test-host.ts";

type Host = Awaited<ReturnType<typeof captainHost>>;

/** A Captain over bb-plugins with one open and one done task, and a thread to adopt. */
async function adoptHost() {
  const host = await captainHost();
  const captainId = await newCaptain(host);
  host.addTask("BBPLUGINS-1", { title: "Render PR images" });
  host.addTask("BBPLUGINS-2", { title: "Old work", status: "done" });
  host.addThread({ id: "thr_side", status: "idle", title: "Fix the sidebar flicker" });
  const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);
  const adopt = async (input: Record<string, unknown>) =>
    (await rpc("adopt", {
      captainId,
      threadId: "thr_side",
      role: "implement",
      ...input,
    })) as AdoptResult;
  const options = async (threadId = "thr_side") =>
    (await rpc("adoptOptions", { threadId, open: 1 })) as AdoptOptions;
  const cli = (args: string[]) => host.harness.behavior.runCli(args, { threadId: captainId });
  const status = () => cli(["status", "--all"]);
  return { host, captainId, rpc, adopt, options, status, cli };
}

const NEW = { kind: "new", projectKey: "BBPLUGINS", title: "Fix the sidebar flicker" };
const EXISTING = { kind: "existing", key: "BBPLUGINS-1" };
const creates = (host: Host) => host.tasks.calls.filter((call) => call.method === "createTask");
const attaches = (host: Host) =>
  host.tasks.calls.filter((call) => call.method === "taskThreadsAttach");
const reasons = (result: AdoptResult) => (result.ok ? [] : result.blockers.map((b) => b.reason));

/** Make the next call of one Tasks method fail, as a timeout or refusal would, until disarmed. */
function failTasksMethod(host: Host, method: string): () => void {
  const calls = host.tasks.calls;
  const push = calls.push.bind(calls);
  let armed = true;
  calls.push = (...entries) => {
    const count = push(...entries);
    if (armed && entries.some((entry) => entry.method === method)) {
      host.tasks.down = true;
      queueMicrotask(() => (host.tasks.down = false));
    }
    return count;
  };
  return () => (armed = false);
}

describe("adoptOptions", () => {
  test("lists the live Captains, their open tasks and the dispatchable roles", async () => {
    const { options, captainId } = await adoptHost();
    const read = await options();
    expect(read.thread).toMatchObject({ id: "thr_side", title: "Fix the sidebar flicker" });
    expect(read.captains).toEqual([
      {
        id: captainId,
        name: "Plugins",
        repos: [expect.objectContaining({ key: "BBPLUGINS" })],
        tasks: [{ key: "BBPLUGINS-1", title: "Render PR images", status: "todo", held: [] }],
        blockers: [],
      },
    ]);
    expect(read.roles.map((role) => role.label)).toEqual(["Implement", "Review"]);
    expect(read.tasksError).toBeNull();
  });

  test("marks the roles another live thread already holds on a task", async () => {
    const { host, captainId, options } = await adoptHost();
    host.addThread({ id: "thr_first", status: "idle", parentThreadId: captainId });
    host.attach(host.tasks.tasks[0]!.id, "thr_first", "Implement");
    expect((await options()).captains[0]?.tasks[0]?.held).toEqual(["implement"]);
  });

  test("a Captain's crew on a task is refused; a Captain's child on no task is not", async () => {
    const { host, captainId, adopt, options } = await adoptHost();
    host.updateThread("thr_side", { parentThreadId: captainId });
    expect((await options()).captains[0]?.blockers).toEqual([]);

    expect((await adopt({ task: EXISTING })).ok).toBe(true);
    expect((await options()).captains[0]?.blockers).toEqual([
      expect.objectContaining({ reason: "thr_side is already crew of the Plugins Captain" }),
    ]);
  });

  for (const preset of ["Implement", "Hotfix"]) {
    test(`a Captain's child live on a task with no role record is refused onto another task (${preset} preset)`, async () => {
      const { host, captainId, rpc, adopt, options } = await adoptHost();
      host.tasks.tasks[1]!.status = "todo";
      host.updateThread("thr_side", { parentThreadId: captainId });
      host.attach(host.tasks.tasks[0]!.id, "thr_side", preset);
      const crew = "thr_side is already crew of the Plugins Captain";
      expect(await rpc("crewOf", { keys: ["thr_side"] })).toEqual({ thr_side: captainId });
      expect((await options()).captains[0]?.blockers).toEqual([
        expect.objectContaining({ reason: crew }),
      ]);
      const result = await adopt({
        role: "review",
        task: { kind: "existing", key: "BBPLUGINS-2" },
      });
      expect(reasons(result)).toEqual([crew]);
      expect(host.tasks.taskThreads).toHaveLength(1);
      expect(host.server.store.crewRole("thr_side")).toBeNull();
    });
  }

  test("a fork's refusal names no placeholder task or role", async () => {
    const { host, options } = await adoptHost();
    host.addThread({ id: "thr_fork", originKind: "fork" });
    const [blocker] = (await options("thr_fork")).captains[0]?.blockers ?? [];
    expect(blocker?.reason).toContain("thr_fork is a fork");
    expect(blocker?.fix).not.toMatch(/<task>|Implement/u);
  });
});

describe("crewOf", () => {
  test("names the Captain each thread is crew of on a task, null otherwise", async () => {
    const { rpc, adopt, captainId } = await adoptHost();
    await adopt({ task: EXISTING });
    expect(await rpc("crewOf", { keys: ["thr_side", "thr_other", captainId] })).toEqual({
      thr_side: captainId,
      thr_other: null,
      [captainId]: null,
    });
  });
  test("a read at the parent-change event of dispatch --thread already names the Captain", async () => {
    const { host, captainId, rpc } = await adoptHost();
    // bb's only event for this adopt is the parent change, made before Tasks'
    // attach: emit it there and read as the menu's refetch would.
    const calls = host.tasks.calls;
    const push = calls.push.bind(calls);
    let read: Promise<unknown> = Promise.resolve();
    calls.push = (...entries) => {
      if (entries.some((entry) => entry.method === "taskThreadsAttach")) {
        read = host.harness.behavior
          .emitThreadEvent("experimental_thread.parentChanged", {
            thread: { ...(host.threads.get("thr_side") as object) },
          } as never)
          .then(() => rpc("crewOf", { keys: ["thr_side"] }));
      }
      return push(...entries);
    };
    const result = await host.harness.behavior.runCli(
      ["dispatch", "BBPLUGINS-1", "--role", "Implement", "--thread", "thr_side"],
      { threadId: captainId },
    );
    expect(result.exitCode).toBe(0);
    expect(await read).toEqual({ thr_side: captainId });
  });
});

describe("adopt", () => {
  test("adopts onto an existing task through the dispatch --thread path", async () => {
    const { host, captainId, adopt, status } = await adoptHost();

    const result = await adopt({ task: EXISTING });

    expect(result).toEqual({
      ok: true,
      task: "BBPLUGINS-1",
      created: false,
      detail: "contract on first tell",
      warnings: [],
    });
    // The same writes `bb captain dispatch --thread` makes.
    expect(host.harness.inspection.sdk.callsTo("threads.update")[0]?.[0]).toEqual({
      threadId: "thr_side",
      parentThreadId: captainId,
      parentNotifications: "stuck",
    });
    expect(attaches(host)[0]?.input).toEqual({
      taskId: host.tasks.tasks[0]?.id,
      threadId: "thr_side",
      presetName: "Implement",
    });
    expect(host.server.store.crewRole("thr_side")).toMatchObject({
      captainId,
      role: "implement",
      contractSent: false,
    });
    expect(creates(host)).toHaveLength(0);
    expect((await status()).stdout).toMatch(/BBPLUGINS-1\s+\S+\s+thr_side\s+Implement/u);
  });

  test("an active thread gets its contract at once, sent as the Captain", async () => {
    const { host, captainId, adopt } = await adoptHost();
    host.updateThread("thr_side", { status: "active" });
    expect(await adopt({ task: EXISTING })).toMatchObject({ ok: true, detail: "contract sent" });
    expect(host.sent.map((message) => [message.threadId, message.senderThreadId])).toEqual([
      ["thr_side", captainId],
    ]);
  });

  test("carries dispatch's warning for a thread outside full permission mode", async () => {
    const { host, adopt } = await adoptHost();
    host.permissionModes.set("thr_side", "auto");
    expect(await adopt({ task: EXISTING })).toMatchObject({
      ok: true,
      warnings: [
        "warning: thr_side runs in auto permission mode; Captain tells cannot approve escalations for it",
      ],
    });
  });

  test("creates a task from the thread's title, then adopts onto it", async () => {
    const { host, adopt } = await adoptHost();
    const result = await adopt({ role: "implement", task: NEW });
    expect(result).toMatchObject({ ok: true, task: "BBPLUGINS-3", created: true });
    expect(creates(host)[0]?.input).toMatchObject({
      title: "Fix the sidebar flicker",
      status: "todo",
    });
    expect(host.server.store.crewRole("thr_side")).toMatchObject({ role: "implement" });
  });

  test("a task another live thread holds in that role is refused with no CLI-only fix", async () => {
    const { host, captainId, adopt } = await adoptHost();
    host.addThread({ id: "thr_first", status: "idle", parentThreadId: captainId });
    host.attach(host.tasks.tasks[0]!.id, "thr_first", "Implement");
    const result = await adopt({ task: EXISTING });
    expect(result).toEqual({
      ok: false,
      blockers: [
        {
          reason: "BBPLUGINS-1 already has a live Implement thread, thr_first",
          fix: "pick another task or role",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("--again");
    expect(host.threads.get("thr_side")?.parentThreadId ?? null).toBeNull();
  });

  test("refuses a Captain thread", async () => {
    const { captainId, adopt } = await adoptHost();
    expect(reasons(await adopt({ threadId: captainId, task: EXISTING }))).toEqual([
      `${captainId} is a Captain`,
    ]);
  });

  test("a task outside the Captain's repos is refused as dispatch refuses it", async () => {
    const { host, adopt } = await adoptHost();
    host.addTask("OTHER-1");
    expect(reasons(await adopt({ task: { kind: "existing", key: "OTHER-1" } }))).toEqual([
      expect.stringContaining("not in this Captain's repos"),
    ]);
  });
});

// Review findings 1 and 2 on 8f210e0, from its repro tests.
describe("adopts onto one task and role", () => {
  test("two threads at once: one is adopted, the other refused, as is a third later", async () => {
    const { host, adopt, status } = await adoptHost();
    host.addThread({ id: "thr_two", status: "idle", title: "Another" });
    host.addThread({ id: "thr_three", status: "idle", title: "A third" });
    const [one, two] = await Promise.all([
      adopt({ task: EXISTING }),
      adopt({ threadId: "thr_two", task: EXISTING }),
    ]);
    expect(one.ok).toBe(true);
    expect(reasons(two)).toEqual(["BBPLUGINS-1 already has a live Implement thread, thr_side"]);
    expect(reasons(await adopt({ threadId: "thr_three", task: EXISTING }))).toEqual([
      "BBPLUGINS-1 already has a live Implement thread, thr_side",
    ]);
    expect((await status()).stdout).not.toMatch(/thr_two|thr_three/u);
  });
});

describe("a refused or retried adopt with a new task makes no extra task", () => {
  test("a refused thread creates no task and changes nothing", async () => {
    const { host, adopt } = await adoptHost();
    host.addThread({ id: "thr_fork", originKind: "fork" });
    const result = await adopt({ threadId: "thr_fork", task: NEW });
    expect(reasons(result)).toEqual([expect.stringContaining("thr_fork is a fork")]);
    expect(creates(host)).toHaveLength(0);
    expect(host.harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
  });

  test("a missing role preset refuses before the task exists, on every retry", async () => {
    const { host, adopt } = await adoptHost();
    const review = host.tasks.presets.findIndex((preset) => preset.name === "Review");
    host.tasks.presets.splice(review, 1);
    const first = await adopt({ role: "review", task: NEW });
    const second = await adopt({ role: "review", task: NEW });
    expect(reasons(first)).toEqual(["Tasks has no Review preset"]);
    expect(second).toEqual(first);
    expect(creates(host)).toHaveLength(0);
    expect(host.threads.get("thr_side")?.parentThreadId ?? null).toBeNull();
  });

  test("a Tasks failure in dispatch's own reads refuses before the task exists", async () => {
    const { host, adopt } = await adoptHost();
    const disarm = failTasksMethod(host, "listPresets");
    const first = await adopt({ task: NEW });
    expect(first.ok).toBe(false);
    expect(creates(host)).toHaveLength(0);
    disarm();
    expect(await adopt({ task: NEW })).toMatchObject({ ok: true, created: true });
    expect(creates(host)).toHaveLength(1);
  });

  test("a failure after the task exists: the retry adopts onto that task", async () => {
    const { host, adopt } = await adoptHost();
    // After the task exists, adopt reads the thread once, then `threads.update`
    // reads it again: fail that second read, so the update throws.
    const get = host.threads.get.bind(host.threads);
    let reads = 0;
    let failing = true;
    host.threads.get = (id: string) => {
      if (id === "thr_side" && failing && creates(host).length > 0 && ++reads === 2)
        return undefined;
      return get(id);
    };
    await expect(adopt({ task: NEW })).rejects.toThrow();
    expect(creates(host)).toHaveLength(1);
    failing = false;
    expect(await adopt({ task: NEW })).toMatchObject({ ok: true, task: "BBPLUGINS-3" });
    expect(creates(host)).toHaveLength(1);
  });

  test("two adopts of one thread at once run in turn: the second finds it crew", async () => {
    const { host, adopt } = await adoptHost();
    const [one, two] = await Promise.all([adopt({ task: NEW }), adopt({ task: NEW })]);
    expect(one).toMatchObject({ ok: true, task: "BBPLUGINS-3" });
    expect(reasons(two)).toEqual(["thr_side is already crew of the Plugins Captain"]);
    expect(creates(host)).toHaveLength(1);
  });
});

describe("a new task reuses only the task its own failed attempt left", () => {
  test("after a finished adopt and a detach, another title gets its own task", async () => {
    const { host, adopt } = await adoptHost();
    expect(await adopt({ task: NEW })).toMatchObject({ ok: true, created: true });
    host.updateThread("thr_side", { parentThreadId: null });
    const second = await adopt({ role: "review", task: { ...NEW, title: "Different work" } });
    expect(second).toMatchObject({ ok: true, task: "BBPLUGINS-4", created: true });
    expect(creates(host)).toHaveLength(2);
  });

  test("after a finished adopt and a detach, the same title gets its own task", async () => {
    const { host, adopt } = await adoptHost();
    expect(await adopt({ task: NEW })).toMatchObject({ ok: true, task: "BBPLUGINS-3" });
    host.updateThread("thr_side", { parentThreadId: null });
    expect(await adopt({ role: "review", task: NEW })).toMatchObject({
      ok: true,
      task: "BBPLUGINS-4",
      created: true,
    });
  });

  test("a retry with an edited title gets a task with that title", async () => {
    const { host, adopt } = await adoptHost();
    const disarm = failTasksMethod(host, "taskThreadsAttach");
    expect((await adopt({ task: NEW })).ok).toBe(false);
    disarm();
    const second = await adopt({ task: { ...NEW, title: "Retitled before retry" } });
    expect(second).toMatchObject({ ok: true, created: true });
    const made = host.tasks.tasks.find((task) => task.key === (second.ok ? second.task : ""));
    expect(made?.title).toBe("Retitled before retry");
  });

  test("a failed attempt's task the Captain has since dispatched is not reused", async () => {
    const { host, adopt, cli } = await adoptHost();
    const disarm = failTasksMethod(host, "taskThreadsAttach");
    expect((await adopt({ task: NEW })).ok).toBe(false);
    disarm();
    expect((await cli(["dispatch", "BBPLUGINS-3", "--role", "Implement"])).exitCode).toBe(0);
    expect(await adopt({ task: NEW })).toMatchObject({
      ok: true,
      task: "BBPLUGINS-4",
      created: true,
    });
  });

  for (const position of [1, 2, 3, 4, 5, 6]) {
    test(`a thread read that fails at read ${position}: a retry ends adopted on one task`, async () => {
      const { host, captainId, adopt } = await adoptHost();
      const get = host.threads.get.bind(host.threads);
      let reads = 0;
      let failing = true;
      host.threads.get = (id: string) => {
        if (id === "thr_side" && failing && ++reads === position) return undefined;
        return get(id);
      };
      const first = await adopt({ task: NEW }).catch(() => null);
      failing = false;
      // A read late enough fails after the adopt finished; the retry then finds it crew.
      if (first?.ok !== true) expect((await adopt({ task: NEW })).ok).toBe(true);
      expect(host.server.store.crewRole("thr_side")).toMatchObject({ captainId });
      expect(creates(host)).toHaveLength(1);
      expect(host.tasks.taskThreads).toHaveLength(1);
    });
  }
});

describe("a half-finished adopt can be finished from the dialog", () => {
  test.each(["dialog", "CLI"])(
    "a landed attach can be retried through the %s after a check pass",
    async (entry) => {
      const { host, captainId, adopt, cli, options, rpc } = await adoptHost();
      const disarm = failTasksMethod(host, "taskThreadsAttach");
      expect((await adopt({ task: EXISTING })).ok).toBe(false);
      disarm();
      host.attach(host.tasks.tasks[0]!.id, "thr_side", "Implement");

      expect((await host.server.check.pass()).skipped).toEqual([]);

      if (entry === "dialog") {
        expect(await rpc("crewOf", { keys: ["thr_side"] })).toEqual({ thr_side: null });
        expect((await options()).captains[0]?.blockers).toEqual([]);
        expect(await adopt({ task: EXISTING })).toMatchObject({ ok: true });
      } else {
        expect(
          (await cli(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--thread", "thr_side"]))
            .exitCode,
        ).toBe(0);
      }
      expect(host.tasks.taskThreads).toHaveLength(1);
      expect((await cli(["tell", "BBPLUGINS-1", "--message", "Continue."])).exitCode).toBe(0);
      expect((await cli(["tell", "BBPLUGINS-1", "--message", "Send an update."])).exitCode).toBe(0);
      expect(host.sent.filter((message) => message.threadId === "thr_side")).toEqual([
        expect.objectContaining({
          text: expect.stringMatching(/Final:[\s\S]*Continue\./u),
          senderThreadId: captainId,
        }),
        expect.objectContaining({ text: "Send an update.", senderThreadId: captainId }),
      ]);
    },
  );

  test.each(["edited title", "old Captain role"])(
    "a landed new-task attach can be retried with an %s",
    async (scenario) => {
      const { host, adopt, cli } = await adoptHost();
      if (scenario === "old Captain role") {
        const oldCaptainId = await newCaptain(host, ["--name", "Previous", "--repo", "bb-plugins"]);
        const oldAdoption = await host.harness.behavior.runCli(
          ["dispatch", "BBPLUGINS-1", "--role", "Implement", "--thread", "thr_side"],
          { threadId: oldCaptainId },
        );
        expect(oldAdoption.exitCode).toBe(0);
        host.updateThread("thr_side", { parentThreadId: null });
        host.tasks.taskThreads.length = 0;
      }
      const disarm = failTasksMethod(host, "taskThreadsAttach");
      expect((await adopt({ task: NEW })).ok).toBe(false);
      disarm();
      host.attach(
        host.tasks.tasks.find((task) => task.key === "BBPLUGINS-3")!.id,
        "thr_side",
        "Implement",
      );

      const title = scenario === "edited title" ? "Another title" : NEW.title;
      expect(await adopt({ task: { ...NEW, title } })).toMatchObject({
        ok: true,
        task: "BBPLUGINS-3",
        created: false,
      });
      expect(creates(host)).toHaveLength(1);
      expect(host.tasks.taskThreads).toHaveLength(1);
      expect((await cli(["tell", "BBPLUGINS-3", "--message", "Continue."])).exitCode).toBe(0);
      expect(host.sent.at(-1)?.text).toMatch(/Final:[\s\S]*Continue\./u);
    },
  );

  test("attach fails after the parent is set; Adopt again converges", async () => {
    const { host, captainId, adopt, options, status } = await adoptHost();
    const disarm = failTasksMethod(host, "taskThreadsAttach");
    const first = await adopt({ task: EXISTING });
    expect(first).toMatchObject({
      ok: false,
      blockers: [{ fix: "press Adopt again; it continues where this one stopped" }],
    });
    expect(host.threads.get("thr_side")).toMatchObject({ parentThreadId: captainId });
    expect(host.server.store.crewRole("thr_side")).toBeNull();
    // The menu still offers it, and the dialog shows no blocker.
    expect((await options()).captains[0]?.blockers).toEqual([]);

    disarm();
    expect(await adopt({ task: EXISTING })).toMatchObject({ ok: true, task: "BBPLUGINS-1" });
    expect(host.tasks.taskThreads.map((row) => row.threadId)).toEqual(["thr_side"]);
    expect(host.server.store.crewRole("thr_side")).toMatchObject({ captainId, role: "implement" });
    expect((await status()).stdout).toMatch(/BBPLUGINS-1\s+\S+\s+thr_side\s+Implement/u);
  });

  test("with a new task: the retry attaches to the task the first attempt made", async () => {
    const { host, adopt } = await adoptHost();
    const disarm = failTasksMethod(host, "taskThreadsAttach");
    expect((await adopt({ task: NEW })).ok).toBe(false);
    disarm();
    expect(await adopt({ task: NEW })).toMatchObject({ ok: true, task: "BBPLUGINS-3" });
    expect(creates(host)).toHaveLength(1);
    expect(host.tasks.taskThreads.map((row) => row.threadId)).toEqual(["thr_side"]);
  });

  test("an attach that landed but reported failure: Adopt again records the role", async () => {
    const { host, captainId, adopt, cli } = await adoptHost();
    const disarm = failTasksMethod(host, "taskThreadsAttach");
    expect((await adopt({ task: EXISTING })).ok).toBe(false);
    disarm();
    // Tasks did attach it: a timeout after the work was done.
    host.attach(host.tasks.tasks[0]!.id, "thr_side", "Implement");
    const retry = await adopt({ task: EXISTING });
    expect(retry).toMatchObject({ ok: true, task: "BBPLUGINS-1", created: false });
    expect(retry.ok && retry.detail).toContain("contract on first tell");
    expect(host.server.store.crewRole("thr_side")).toMatchObject({
      captainId,
      role: "implement",
      contractSent: false,
    });
    expect(host.tasks.taskThreads).toHaveLength(1);
    expect((await cli(["status", "--all"])).stdout).toMatch(
      /BBPLUGINS-1\s+\S+\s+thr_side\s+Implement/u,
    );
  });

  test("an attach to a new task that landed but reported failure: Adopt again resumes that task", async () => {
    const { host, adopt } = await adoptHost();
    const disarm = failTasksMethod(host, "taskThreadsAttach");
    expect((await adopt({ task: NEW })).ok).toBe(false);
    disarm();
    host.attach(
      host.tasks.tasks.find((task) => task.key === "BBPLUGINS-3")!.id,
      "thr_side",
      "Implement",
    );
    expect(await adopt({ task: NEW })).toMatchObject({
      ok: true,
      task: "BBPLUGINS-3",
      created: false,
    });
    expect(creates(host)).toHaveLength(1);
    expect(host.tasks.taskThreads).toHaveLength(1);
  });
});
