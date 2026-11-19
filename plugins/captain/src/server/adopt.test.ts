import { describe, expect, test } from "vitest";
import type { AdoptOptions, AdoptResult } from "../contract/rpc.ts";
import { captainHost, newCaptain } from "./test-host.ts";

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
  const status = () => host.harness.behavior.runCli(["status", "--all"], { threadId: captainId });
  return { host, captainId, rpc, adopt, status };
}

const taskCreates = (host: Awaited<ReturnType<typeof captainHost>>) =>
  host.tasks.calls.filter((call) => call.method === "createTask");

describe("adoptOptions", () => {
  test("lists the live Captains, their open tasks and the dispatchable roles", async () => {
    const { rpc, captainId } = await adoptHost();
    const options = (await rpc("adoptOptions", { threadId: "thr_side" })) as AdoptOptions;
    expect(options.thread).toMatchObject({ id: "thr_side", title: "Fix the sidebar flicker" });
    expect(options.captains).toEqual([
      {
        id: captainId,
        name: "Plugins",
        repos: [expect.objectContaining({ key: "BBPLUGINS" })],
        tasks: [{ key: "BBPLUGINS-1", title: "Render PR images", status: "todo" }],
        blockers: [],
      },
    ]);
    expect(options.roles.map((role) => role.label)).toEqual(["Plan", "Implement", "Review"]);
    expect(options.tasksError).toBeNull();
  });

  test("names why a Captain's own crew cannot be adopted again", async () => {
    const { host, rpc, captainId } = await adoptHost();
    host.updateThread("thr_side", { parentThreadId: captainId });
    const options = (await rpc("adoptOptions", { threadId: "thr_side" })) as AdoptOptions;
    expect(options.captains[0]?.blockers).toEqual([
      expect.objectContaining({ reason: "thr_side is crew of the Plugins Captain" }),
    ]);
  });
});

describe("adopt", () => {
  test("adopts onto an existing task through the dispatch --thread path", async () => {
    const { host, captainId, adopt, status } = await adoptHost();

    const result = await adopt({ task: { kind: "existing", key: "BBPLUGINS-1" } });

    expect(result).toMatchObject({
      ok: true,
      task: "BBPLUGINS-1",
      created: false,
      state: "adopted",
      adopted: true,
    });
    // The same writes `bb captain dispatch --thread` makes.
    expect(host.harness.inspection.sdk.callsTo("threads.update")[0]?.[0]).toEqual({
      threadId: "thr_side",
      parentThreadId: captainId,
      parentNotifications: "stuck",
    });
    expect(host.tasks.calls.find((call) => call.method === "taskThreadsAttach")?.input).toEqual({
      taskId: host.tasks.tasks[0]?.id,
      threadId: "thr_side",
      presetName: "Implement",
    });
    expect(host.server.store.crewRole("thr_side")).toMatchObject({
      captainId,
      role: "implement",
      contractSent: false,
    });
    expect(taskCreates(host)).toHaveLength(0);
    expect((await status()).stdout).toMatch(/BBPLUGINS-1\s+\S+\s+thr_side\s+Implement/u);
  });

  test("carries dispatch's warning for a thread outside full permission mode", async () => {
    const { host, adopt } = await adoptHost();
    host.permissionModes.set("thr_side", "auto");
    const result = await adopt({ task: { kind: "existing", key: "BBPLUGINS-1" } });
    expect(result).toMatchObject({
      ok: true,
      adopted: true,
      warnings: [
        "warning: thr_side runs in auto permission mode; Captain tells cannot approve escalations for it",
      ],
    });
  });

  test("creates a task from the thread's title, then adopts onto it", async () => {
    const { host, adopt } = await adoptHost();

    const result = await adopt({
      role: "plan",
      task: { kind: "new", projectKey: "BBPLUGINS", title: "Fix the sidebar flicker" },
    });

    expect(result).toMatchObject({ ok: true, task: "BBPLUGINS-3", created: true, adopted: true });
    expect(taskCreates(host)[0]?.input).toMatchObject({
      title: "Fix the sidebar flicker",
      status: "todo",
    });
    expect(host.server.store.crewRole("thr_side")).toMatchObject({ role: "plan" });
  });

  test("a refused thread creates no task and changes nothing", async () => {
    const { host, adopt } = await adoptHost();
    host.addThread({ id: "thr_fork", originKind: "fork" });

    const result = await adopt({
      threadId: "thr_fork",
      task: { kind: "new", projectKey: "BBPLUGINS", title: "Forked work" },
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.map((blocker) => blocker.reason)).toEqual([
      expect.stringContaining("thr_fork is a fork"),
    ]);
    expect(taskCreates(host)).toHaveLength(0);
    expect(host.harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
  });

  test("refuses a Captain thread and a thread already crew", async () => {
    const { host, captainId, adopt } = await adoptHost();

    const self = await adopt({
      threadId: captainId,
      task: { kind: "existing", key: "BBPLUGINS-1" },
    });
    expect(self.ok).toBe(false);
    expect(self.blockers[0]?.reason).toBe(`${captainId} is a Captain`);

    host.updateThread("thr_side", { parentThreadId: captainId });
    const crew = await adopt({ task: { kind: "existing", key: "BBPLUGINS-1" } });
    expect(crew).toMatchObject({
      ok: false,
      blockers: [expect.objectContaining({ reason: "thr_side is crew of the Plugins Captain" })],
    });
    expect(host.tasks.calls.filter((call) => call.method === "taskThreadsAttach")).toHaveLength(0);
  });

  test("a task outside the Captain's repos is refused as dispatch refuses it", async () => {
    const { host, adopt } = await adoptHost();
    host.addTask("OTHER-1");
    const result = await adopt({ task: { kind: "existing", key: "OTHER-1" } });
    expect(result).toMatchObject({
      ok: false,
      blockers: [
        expect.objectContaining({ reason: expect.stringContaining("not in this Captain's repos") }),
      ],
    });
  });
});
