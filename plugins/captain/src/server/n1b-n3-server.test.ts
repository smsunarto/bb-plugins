// Round-2 review of BBP-41 (N1, N3), kept as regression tests.
import { expect, test } from "vitest";
import type { AdoptResult } from "../contract/rpc.ts";
import { captainHost, newCaptain } from "./test-host.ts";

const BASE = process.env["BUGS_BASE"] === "1";
const TAG = BASE ? "[base 2a07761e8]" : "[head caec5bff5]";
type Host = Awaited<ReturnType<typeof captainHost>>;
const say = (line: string) => process.stderr.write(`${TAG} ${line}\n`);

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
  const cli = (args: string[]) => host.harness.behavior.runCli(args, { threadId: captainId });
  return { host, captainId, rpc, adopt, cli };
}
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

test.skipIf(BASE)(
  "S3 the orphan of a failed attempt, since dispatched by the Captain, blocks every later 'new task'",
  async () => {
    const { host, adopt, cli } = await adoptHost();
    const disarm = failTasksMethod(host, "taskThreadsAttach");
    say(
      "S3 first adopt (attach fails): " +
        JSON.stringify(
          await adopt({
            task: { kind: "new", projectKey: "BBPLUGINS", title: "Fix the sidebar flicker" },
          }),
        ),
    );
    disarm();
    // The user closes the dialog. The orphan todo task is on the board; the Captain dispatches it.
    say(
      "S3 bb captain dispatch BBPLUGINS-3 --role Implement: " +
        (await cli(["dispatch", "BBPLUGINS-3", "--role", "Implement"])).stdout.trim(),
    );
    const again = await adopt({
      task: { kind: "new", projectKey: "BBPLUGINS", title: "Some other work for this thread" },
    });
    say("S3 later adopt, New task 'Some other work for this thread': " + JSON.stringify(again));
    const third = await adopt({
      role: "implement",
      task: { kind: "new", projectKey: "BBPLUGINS", title: "Third try" },
    });
    say("S3 and again: " + JSON.stringify(third));
    say("S3 createTask calls in total: " + creates(host).length);
    expect(again.ok).toBe(true);
  },
);

// N3 was accepted with no change: a repo key the Captain does not own is refused.
test.skip("A1 server: the fallback Captain with the gone Captain's repo key", async () => {
  const { host, rpc } = await adoptHost();
  const rampage = await newCaptain(host, ["--name", "Rampage", "--repo", "rampage"]);
  const result = await rpc("adopt", {
    captainId: rampage,
    threadId: "thr_side",
    role: "implement",
    task: { kind: "new", projectKey: "BBPLUGINS", title: "Fix the sidebar flicker" },
  });
  say("A1 server answer: " + JSON.stringify(result));
  expect((result as AdoptResult).ok).toBe(true);
});

test("S5b two threads adopted onto one task and role at once", async () => {
  const { host, adopt, cli } = await adoptHost();
  host.addThread({ id: "thr_two", status: "idle", title: "Another" });
  const [one, two] = await Promise.all([
    adopt({ task: { kind: "existing", key: "BBPLUGINS-1" } }),
    adopt({ threadId: "thr_two", task: { kind: "existing", key: "BBPLUGINS-1" } }),
  ]);
  say("S5b one: " + JSON.stringify(one));
  say("S5b two: " + JSON.stringify(two));
  say(
    "S5b status: " +
      (await cli(["status", "--all"])).stdout.trim().split("\n").slice(1).join(" | "),
  );
  // Sequentially, the second is refused:
  host.addThread({ id: "thr_three", status: "idle" });
  say(
    "S5b a third, afterwards: " +
      JSON.stringify(
        await adopt({ threadId: "thr_three", task: { kind: "existing", key: "BBPLUGINS-1" } }),
      ),
  );
  expect([one.ok, two.ok]).toEqual([true, false]);
});
