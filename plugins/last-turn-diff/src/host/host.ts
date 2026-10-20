import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { snapshotHostContract } from "../shared/host-contract.ts";
import { checkoutId, forget, pin, snapshot, turnPatches } from "./snapshots.ts";

export default experimental_defineHostEntry({
  contract: snapshotHostContract,
  handlers: {
    async sync({ operations, job }, { signal }) {
      const applied: string[] = [];
      /** Checkouts with a refused marker; the server retries it and gives up after a few. */
      const owed = new Set<string>();
      for (const operation of operations) {
        try {
          if (operation.method === "pin") {
            await pin(
              operation.input.environmentPath,
              operation.input.threadId,
              operation.input.captures,
              signal,
            );
          } else {
            await forget(
              operation.input.environmentPath,
              operation.input.threadId,
              operation.input.at,
              signal,
            );
          }
          applied.push(operation.id);
        } catch {
          // Keep this operation owed, but let unrelated threads' markers land.
          const id = await checkoutId(operation.input.environmentPath, signal).catch(() => null);
          if (id) owed.add(id);
        }
      }
      try {
        // A capture writes no refs, so a refused marker never holds one back.
        if (job.kind === "capture")
          return { applied, commit: await snapshot(job.environmentPath, signal) };
        if (job.kind === "scan") {
          // Reading before a missing lifecycle marker could misattribute
          // another thread's edits, but only within the marker's own checkout.
          if (owed.size > 0 && owed.has((await checkoutId(job.environmentPath, signal)) ?? ""))
            return { applied, error: "Workspace markers remain owed" };
          return {
            applied,
            snapshots: await turnPatches(job.environmentPath, job.threadId, job.candidates, signal),
          };
        }
        return { applied };
      } catch (error) {
        return { applied, error: String(error) };
      }
    },
  },
});
