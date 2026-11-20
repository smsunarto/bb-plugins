// Round-2 review of BBP-41 (N1, N2), kept as regression tests.
import { describe, expect, test } from "vitest";
import type { AdoptOptions, AdoptResult } from "../contract/rpc.ts";
import { captainHost, newCaptain } from "./test-host.ts";

type Host = Awaited<ReturnType<typeof captainHost>>;

async function adoptHost() {
  const host = await captainHost();
  const captainId = await newCaptain(host);
  host.addTask("BBPLUGINS-1", { title: "Render PR images" });
  host.addTask("BBPLUGINS-2", { title: "Second open task" });
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
  const status = () => host.harness.behavior.runCli(["status", "--all"], { threadId: captainId });
  return { host, captainId, rpc, adopt, options, status };
}

const NEW = { kind: "new", projectKey: "BBPLUGINS", title: "Fix the sidebar flicker" };
const creates = (host: Host) => host.tasks.calls.filter((call) => call.method === "createTask");

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

describe("S1-S3 marker reuse (adopt.ts:193-195)", () => {
  test("S1 a finished adopt's task swallows a later, different 'new task' of the same thread", async () => {
    const { host, adopt } = await adoptHost();
    const first = await adopt({ task: NEW });
    console.log("S1 first", JSON.stringify(first));
    // The thread leaves the crew, as the plugin's own fix text advises (--clear-parent-thread).
    host.updateThread("thr_side", { parentThreadId: null });
    const second = await adopt({
      role: "review",
      task: { kind: "new", projectKey: "BBPLUGINS", title: "Completely different work" },
    });
    console.log("S1 second", JSON.stringify(second));
    console.log("S1 createTask calls", creates(host).length);
    console.log(
      "S1 tasks",
      JSON.stringify(host.tasks.tasks.map((t) => [t.key, t.title, t.status])),
    );
    expect(creates(host)).toHaveLength(2); // expected: a new task for the new title
  });

  // The review asked that the edited title not be dropped. A marked task is
  // resumed only with the same title, so the edited retry gets its own task.
  test("S2 a retry with an edited title gets a task with that title", async () => {
    const { host, adopt } = await adoptHost();
    const disarm = failTasksMethod(host, "taskThreadsAttach");
    const first = await adopt({ task: NEW });
    console.log("S2 first", JSON.stringify(first));
    disarm();
    const second = await adopt({
      task: { kind: "new", projectKey: "BBPLUGINS", title: "Retitled before retry" },
    });
    console.log("S2 second", JSON.stringify(second));
    console.log(
      "S2 tasks",
      JSON.stringify(host.tasks.tasks.map((t) => [t.key, t.title, t.status])),
    );
    expect(second).toMatchObject({ ok: true, created: true });
    const made = host.tasks.tasks.find((t) => t.key === (second.ok ? second.task : ""));
    expect(made?.title).toBe("Retitled before retry");
  });

  test("S3 an orphan task from a failed attempt, since taken by another thread, blocks every 'new task'", async () => {
    const { host, captainId, adopt } = await adoptHost();
    const disarm = failTasksMethod(host, "taskThreadsAttach");
    expect((await adopt({ task: NEW })).ok).toBe(false);
    disarm();
    // The user gives up; the Captain later starts its own Implement thread on the orphan todo task.
    const orphan = host.tasks.tasks.find((t) => t.key === "BBPLUGINS-3")!;
    host.addThread({ id: "thr_spawned", status: "idle", parentThreadId: captainId });
    host.attach(orphan.id, "thr_spawned", "Implement");
    host.server.store.putCrewRole({
      threadId: "thr_spawned",
      captainId,
      role: "implement",
      reportDueSince: null,
      contractSent: true,
    });
    const again = await adopt({
      task: { kind: "new", projectKey: "BBPLUGINS", title: "Some other work for this thread" },
    });
    console.log("S3 again", JSON.stringify(again));
    console.log("S3 createTask calls", creates(host).length);
    expect(again.ok).toBe(true);
  });
});

describe("S4 Captain child attached in Tasks with no crew_roles row", () => {
  test("status lists it as crew on a task, yet options/crewOf/adopt let it onto a second task", async () => {
    const { host, captainId, rpc, adopt, options, status } = await adoptHost();
    // A crew thread Tasks started whose role row is not written yet (late thread, before backfill/converge).
    host.updateThread("thr_side", { parentThreadId: captainId });
    host.attach(host.tasks.tasks[0]!.id, "thr_side", "Implement");
    expect(host.server.store.crewRole("thr_side")).toBeNull();
    console.log("S4 status before:\n" + (await status()).stdout);
    console.log("S4 crewOf", JSON.stringify(await rpc("crewOf", { keys: ["thr_side"] })));
    console.log("S4 blockers", JSON.stringify((await options()).captains[0]?.blockers));
    const result = await adopt({ role: "review", task: { kind: "existing", key: "BBPLUGINS-2" } });
    console.log("S4 adopt", JSON.stringify(result));
    console.log("S4 status after:\n" + (await status()).stdout);
    console.log(
      "S4 attachments",
      JSON.stringify(
        host.tasks.taskThreads.map((r) => [
          r.taskId === host.tasks.tasks[0]!.id ? "BBPLUGINS-1" : "BBPLUGINS-2",
          r.threadId,
          r.presetName,
        ]),
      ),
    );
    expect(result.ok).toBe(false);
  });
});

describe("S5 the adopt:<thread> guard", () => {
  // Dropped in the round-2 review: shown only with a synthetic hang; bb calls carry no deadline here.
  test.skip("S5a a bb call that never settles inside the guard blocks every later adopt of that thread", async () => {
    const { host, adopt } = await adoptHost();
    const sdkThreads = (host as never as { bb: { sdk: { threads: { update: unknown } } } }).bb.sdk
      .threads;
    const original = sdkThreads.update;
    sdkThreads.update = () => new Promise(() => {});
    const hung = adopt({ task: { kind: "existing", key: "BBPLUGINS-1" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    sdkThreads.update = original; // bb answers again
    const later = adopt({ task: { kind: "existing", key: "BBPLUGINS-1" } });
    const outcome = await Promise.race([
      later.then(() => "settled"),
      hung.then(() => "first settled"),
      new Promise((resolve) => setTimeout(() => resolve("still waiting after 1500ms"), 1500)),
    ]);
    console.log("S5a later adopt:", outcome);
    expect(outcome).toBe("settled");
  });

  test("S5b two threads onto one task and role at once", async () => {
    const { host, adopt, status } = await adoptHost();
    host.addThread({ id: "thr_two", status: "idle", title: "Another" });
    const [one, two] = await Promise.all([
      adopt({ task: { kind: "existing", key: "BBPLUGINS-1" } }),
      adopt({ threadId: "thr_two", task: { kind: "existing", key: "BBPLUGINS-1" } }),
    ]);
    console.log("S5b", JSON.stringify(one), JSON.stringify(two));
    console.log("S5b status:\n" + (await status()).stdout);
    expect([one.ok, two.ok]).toEqual([true, false]);
  });
});

describe("S7 crewOf freshness after bb captain dispatch --thread", () => {
  test("nothing invalidates crew-of:<thread> after the role row is written", async () => {
    const { host, captainId, rpc } = await adoptHost();
    const invalidations = () => host.harness.inspection.experimental_rpcInvalidations.flat();
    const reads: unknown[] = [];
    // bb's only event for this adopt is the parent change, which threads.update makes
    // before Tasks' attach is called. Emit it there and read as the menu's refetch would.
    const calls = host.tasks.calls;
    const push = calls.push.bind(calls);
    let pending: Promise<unknown> = Promise.resolve();
    calls.push = (...entries) => {
      if (entries.some((entry) => entry.method === "taskThreadsAttach")) {
        pending = host.harness.behavior
          .emitThreadEvent("experimental_thread.parentChanged", {
            thread: { ...(host.threads.get("thr_side") as object) },
          } as never)
          .then(async () => reads.push(await rpc("crewOf", { keys: ["thr_side"] })));
      }
      return push(...entries);
    };
    const before = invalidations().length;
    const result = await host.harness.behavior.runCli(
      ["dispatch", "BBPLUGINS-1", "--role", "Implement", "--thread", "thr_side"],
      { threadId: captainId },
    );
    await pending;
    console.log("S7 cli", result.exitCode, result.stdout.trim());
    console.log("S7 invalidations during dispatch", JSON.stringify(invalidations().slice(before)));
    console.log("S7 crewOf read at the invalidation", JSON.stringify(reads));
    console.log("S7 crewOf now", JSON.stringify(await rpc("crewOf", { keys: ["thr_side"] })));
    expect(reads[0]).toEqual({ thr_side: captainId });
  });
});
