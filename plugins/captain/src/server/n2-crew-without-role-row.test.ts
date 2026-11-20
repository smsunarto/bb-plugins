// Round-2 review of BBP-41 (N2), kept as a regression test.
import { expect, test } from "vitest";
import type { AdoptResult } from "../contract/rpc.ts";
import { captainHost, newCaptain } from "./test-host.ts";

const BASE = process.env["BUGS_BASE"] === "1";

for (const preset of ["Implement", "Hotfix"]) {
  test(`S4 Captain child live on a task with preset ${preset}, no crew_roles row`, async () => {
    const host = await captainHost();
    const captainId = await newCaptain(host);
    host.addTask("BBPLUGINS-1", { title: "Render PR images" });
    host.addTask("BBPLUGINS-2", { title: "Second open task" });
    host.addThread({ id: "thr_side", status: "idle", title: "Fix", parentThreadId: captainId });
    host.attach(host.tasks.tasks[0]!.id, "thr_side", preset);
    const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);
    const status = async () =>
      (await host.harness.behavior.runCli(["status", "--all"], { threadId: captainId })).stdout
        .trim()
        .split("\n")
        .slice(1)
        .join(" | ");
    const lines = [`[${BASE ? "base 2a07761e8" : "head caec5bff5"}] preset=${preset}`];
    lines.push("status before: " + (await status()));
    const options = (await rpc(
      "adoptOptions",
      BASE ? { threadId: "thr_side" } : { threadId: "thr_side", open: 1 },
    )) as { captains: { blockers: unknown[] }[] };
    lines.push("dialog blockers: " + JSON.stringify(options.captains[0]?.blockers));
    if (!BASE) lines.push("crewOf: " + JSON.stringify(await rpc("crewOf", { keys: ["thr_side"] })));
    const result = (await rpc("adopt", {
      captainId,
      threadId: "thr_side",
      role: "review",
      task: { kind: "existing", key: "BBPLUGINS-2" },
    })) as AdoptResult;
    lines.push("adopt onto BBPLUGINS-2 as Review: " + JSON.stringify(result));
    lines.push("status after: " + (await status()));
    lines.push(
      "attachments: " +
        JSON.stringify(
          host.tasks.taskThreads.map((r) => [
            host.tasks.tasks.find((t) => t.id === r.taskId)?.key,
            r.threadId,
            r.presetName,
          ]),
        ),
    );
    process.stderr.write(lines.join("\n") + "\n\n");
    expect(result.ok).toBe(false);
  });
}
