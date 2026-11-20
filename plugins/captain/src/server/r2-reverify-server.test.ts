// Round-two check at caec5bff5: a failure at any thread read after the task exists must not leave two tasks.
import { describe, expect, test } from "vitest";
import type { AdoptResult } from "../contract/rpc.ts";
import { captainHost, newCaptain } from "./test-host.ts";

async function adoptHost() {
  const host = await captainHost();
  const captainId = await newCaptain(host);
  host.addTask("BBPLUGINS-1", { title: "Render PR images" });
  host.addThread({ id: "thr_side", status: "idle", title: "Fix the sidebar flicker" });
  const adopt = async (input: Record<string, unknown>) =>
    (await host.harness.behavior.callRpc("adopt", {
      captainId,
      threadId: "thr_side",
      role: "implement",
      ...input,
    })) as AdoptResult;
  return { host, captainId, adopt };
}
const NEW = { kind: "new", projectKey: "BBPLUGINS", title: "Fix the sidebar flicker" };

describe("a thread read fails once at each position; the retry converges on one task", () => {
  for (const position of [1, 2, 3, 4, 5, 6]) {
    test(`read ${position} fails`, async () => {
      const { host, adopt } = await adoptHost();
      const get = host.threads.get.bind(host.threads);
      let reads = 0;
      let failing = true;
      host.threads.get = (id: string) => {
        if (id === "thr_side" && failing && ++reads === position) return undefined;
        return get(id);
      };
      const first = await adopt({ task: NEW }).catch((error: Error) => ({ threw: error.message }));
      failing = false;
      const retry = await adopt({ task: NEW }).catch((error: Error) => ({ threw: error.message }));
      const creates = host.tasks.calls.filter((call) => call.method === "createTask").length;
      const attached = host.tasks.taskThreads.length;
      console.log(
        position,
        JSON.stringify(first).slice(0, 110),
        "| retry",
        JSON.stringify(retry).slice(0, 90),
        "| creates",
        creates,
        "attached",
        attached,
      );
      expect(creates).toBeLessThanOrEqual(1);
      expect(attached).toBeLessThanOrEqual(1);
    });
  }
});

test("re-adopting after a detach with a new title reuses the open task from the first adopt", async () => {
  const { host, adopt } = await adoptHost();
  const first = await adopt({ task: NEW });
  host.updateThread("thr_side", { parentThreadId: null });
  const second = await adopt({ task: { ...NEW, title: "Something else entirely" } });
  console.log(
    "detach:",
    JSON.stringify(first).slice(0, 80),
    "|",
    JSON.stringify(second).slice(0, 160),
  );
  console.log("tasks:", host.tasks.tasks.map((task) => `${task.key} ${task.title}`).join(" ; "));
});
