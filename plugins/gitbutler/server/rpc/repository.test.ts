import { expect, test } from "bun:test";
import { stubHostContext } from "@bb-kit/core/testing";
import { repository } from "./repository.ts";

test("reads the repository through the thread's resolved host", async () => {
  const calls: unknown[] = [];
  const context = stubHostContext({
    bb: {
      sdk: {
        threads: { get: async () => ({ environmentId: "env-1", status: "idle" }) },
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
          call: async (method: string, input: unknown, options: unknown) => {
            calls.push({ method, input, options });
            return {
              kind: "ready",
              repository: {
                gitButlerVersion: "0.22.3",
                capturedAt: 1,
                mergeBase: null,
                upstream: { behind: 0, lastFetched: null },
                stacks: [],
                worktree: { files: [], hunkCount: 0 },
              },
            };
          },
        }),
      },
    } as never,
  });

  const result = await repository.execute(context, { threadId: "thread-1" });

  expect(result.repository).toMatchObject({
    kind: "ready",
    repository: { environmentId: "env-1" },
  });
  expect(calls).toEqual([
    {
      method: "inspectRepository",
      input: { repositoryPath: "/remote/repo" },
      options: { hostId: "host-remote" },
    },
  ]);
});
