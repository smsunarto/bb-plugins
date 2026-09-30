import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { snapshotHostContract } from "../shared/host-contract.ts";
import { capture, forget, turnPatch } from "./snapshots.ts";

export default experimental_defineHostEntry({
  contract: snapshotHostContract,
  handlers: {
    async capture({ environmentPath, threadId, at, kind }, context) {
      return { captured: await capture(environmentPath, threadId, at, kind, context.signal) };
    },
    async turnPatch({ environmentPath, threadId, startedAt, completedAt, recordedPaths }, context) {
      return {
        snapshot: await turnPatch(
          environmentPath,
          threadId,
          startedAt,
          completedAt,
          recordedPaths,
          context.signal,
        ),
      };
    },
    async forget({ environmentPath, threadId }, context) {
      await forget(environmentPath, threadId, context.signal);
      return {};
    },
  },
});
