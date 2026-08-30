import { expect, test } from "bun:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createGitButlerHostEntry } from "./host.ts";

test("host entry dispatches both typed methods and carries cancellation", async () => {
  const calls: Array<{ method: string; path: string; aborted: boolean }> = [];
  const entry = createGitButlerHostEntry({
    async inspectRepository(path, signal) {
      calls.push({ method: "inspect", path, aborted: signal.aborted });
      return {
        kind: "unavailable",
        issue: { code: "not-gitbutler-project", message: "not initialized" },
      };
    },
    async commitSelection(path, _intent, signal) {
      calls.push({ method: "commit", path, aborted: signal.aborted });
      return {
        outcome: { kind: "rejected", code: "selection-stale", message: "stale" },
        repository: null,
      };
    },
  });
  const host = experimental_createHostEntryHarness(entry);
  await expect(
    host.experimental_call("inspectRepository", { repositoryPath: "/repo" }),
  ).resolves.toMatchObject({
    kind: "unavailable",
  });
  await expect(
    host.experimental_call("commitSelection", {
      repositoryPath: "/repo",
      intent: {
        message: "message",
        target: { kind: "new", branchName: "scott/new" },
        hunkKeys: [`h1:${"a".repeat(64)}`],
      },
    }),
  ).resolves.toMatchObject({ outcome: { kind: "rejected" } });
  expect(calls).toEqual([
    { method: "inspect", path: "/repo", aborted: false },
    { method: "commit", path: "/repo", aborted: false },
  ]);
  await host.experimental_dispose();
});
