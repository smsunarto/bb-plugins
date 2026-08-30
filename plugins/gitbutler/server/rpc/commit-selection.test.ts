import { expect, test } from "bun:test";
import { stubHostContext } from "@bb-kit/core/testing";
import { commitSelection } from "./commit-selection.ts";

test("blocks a commit before calling the host while the thread is active", async () => {
  let hostCalled = false;
  const context = stubHostContext({
    bb: {
      sdk: {
        threads: { get: async () => ({ environmentId: "env-1", status: "active" }) },
        environments: {
          get: async () => ({
            id: "env-1",
            hostId: "host-remote",
            path: "/remote/repo",
            status: "ready",
            isGitRepo: true,
            isWorktree: false,
          }),
        },
      },
      hosts: {
        experimental_client: () => ({
          call: async () => {
            hostCalled = true;
            throw new Error("host must not be called");
          },
        }),
      },
    } as never,
  });

  const result = await commitSelection.execute(context, {
    threadId: "thread-1",
    intent: {
      message: "message",
      target: { kind: "existing", branchName: "scott/alpha" },
      hunkKeys: [`h1:${"a".repeat(64)}`],
    },
  });

  expect(result.outcome).toMatchObject({ kind: "rejected", code: "thread-active" });
  expect(hostCalled).toBe(false);
});
