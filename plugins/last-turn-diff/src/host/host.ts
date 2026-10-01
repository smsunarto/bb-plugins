import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { snapshotHostContract } from "../shared/host-contract.ts";
import { capture, forget, turnPatch } from "./snapshots.ts";

export default experimental_defineHostEntry({
  contract: snapshotHostContract,
  handlers: {
    async capture({ environmentPath, threadId, at, kind }, context) {
      return { captured: await capture(environmentPath, threadId, at, kind, context.signal) };
    },
    async turnPatch({ environmentPath, threadId, window, recordedPaths, known }, context) {
      return {
        snapshot: await turnPatch(
          environmentPath,
          threadId,
          window,
          recordedPaths,
          known,
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
