import { expect, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HostCall } from "../../../test/harness.ts";
import type { Stack } from "../../shared/schema.ts";
import { otherMachines } from "./other-machines.ts";

const stack: Stack = {
  key: "scott/feature",
  branches: [
    {
      name: "scott/feature",
      status: "ahead",
      rawStatus: "unpushedCommits",
      push: "push",
      reviewId: null,
      ci: null,
      commits: [],
      upstreamCommits: [],
      newUpstream: 0,
    },
  ],
  assignedChanges: [],
};

/**
 * A bb with three machines: the thread's own (`cardinal`), a laptop holding
 * the repository, and one that is asleep. `answers` is what each machine's
 * `checkouts` call returns, by host id; a missing one fails the call.
 */
function machines(
  answers: Record<string, unknown>,
  /** The thread's origin, or "unreadable" for a repository its host cannot find. */
  origin: string | null = "github.com/o/app",
) {
  const calls: HostCall[] = [];
  const bb = {
    sdk: {
      threads: {
        get: async () => ({
          environment: { id: "env-1", hostId: "cardinal", path: "/work/app", status: "ready" },
        }),
      },
      hosts: {
        list: async () => [
          { id: "cardinal", name: "codex@cardinal", status: "connected" },
          { id: "laptop", name: "Personal Mac", status: "connected" },
          { id: "asleep", name: "Dev Mac", status: "disconnected" },
          { id: "broken", name: "gcp", status: "connected" },
        ],
        get: async () => {
          throw new Error("Host not found");
        },
      },
      projects: {
        list: async () => [
          {
            sources: [
              { hostId: "cardinal", path: "/work/app" },
              { hostId: "laptop", path: "/Users/me/git/app" },
              { hostId: "asleep", path: "/Users/me/git/app" },
              { hostId: "broken", path: "/home/me/app" },
            ],
          },
          { sources: [{ hostId: "laptop", path: "/Users/me/git/dotfiles" }] },
        ],
      },
      environments: {
        list: async () => [
          { hostId: "laptop", path: "/Users/me/git/app" },
          { hostId: "cardinal", path: "/work/app-copy" },
        ],
      },
    },
    hosts: {
      experimental_client: () => ({
        call: async (method: string, input: unknown, options: { hostId: string }) => {
          calls.push({ method, input, options });
          if (method === "origin" && origin === "unreadable") {
            throw new Error(
              "No Git repository was found at the environment root or under its repos/ directory.",
            );
          }
          if (method === "origin") return { path: "/real/work/app", origin };
          const answer = answers[options.hostId];
          if (!answer) throw new Error("Unknown method: checkouts");
          return answer;
        },
      }),
    },
    log: { warn: () => {} },
  } as unknown as BbPluginApi;
  return { ctx: { bb }, calls };
}

test("asks each connected machine for its checkouts of the thread's origin", async () => {
  const { ctx, calls } = machines({
    cardinal: {
      checkouts: [
        // The thread's own checkout, which the board already is.
        { path: "/real/work/app", state: "ready", reason: null, stacks: [stack] },
        { path: "/work/app-copy", state: "ready", reason: null, stacks: [] },
      ],
    },
    laptop: {
      checkouts: [{ path: "/Users/me/git/app", state: "ready", reason: null, stacks: [stack] }],
    },
  });

  expect(await otherMachines.execute(ctx, { threadId: "t1", repositoryKey: "." })).toEqual({
    checkouts: [
      {
        path: "/work/app-copy",
        state: "ready",
        reason: null,
        stacks: [],
        hostId: "cardinal",
        machine: "codex@cardinal",
      },
      {
        path: "/Users/me/git/app",
        state: "ready",
        reason: null,
        stacks: [stack],
        hostId: "laptop",
        machine: "Personal Mac",
      },
    ],
    reason: null,
    environmentId: "env-1",
  });
  expect(calls).toEqual([
    {
      method: "origin",
      input: { environmentPath: "/work/app", repositoryKey: "." },
      options: { hostId: "cardinal" },
    },
    {
      method: "checkouts",
      input: { paths: ["/work/app", "/work/app-copy"], origin: "github.com/o/app" },
      options: { hostId: "cardinal", timeoutMs: 30_000 },
    },
    {
      method: "checkouts",
      input: {
        paths: ["/Users/me/git/app", "/Users/me/git/dotfiles"],
        origin: "github.com/o/app",
      },
      options: { hostId: "laptop", timeoutMs: 30_000 },
    },
    // gcp is asked and fails; Dev Mac is asleep and never asked.
    {
      method: "checkouts",
      input: { paths: ["/home/me/app"], origin: "github.com/o/app" },
      options: { hostId: "broken", timeoutMs: 30_000 },
    },
  ]);
});

test("a repository with no origin asks no other machine", async () => {
  const { ctx, calls } = machines({}, null);

  expect(await otherMachines.execute(ctx, { threadId: "t1" })).toEqual({
    checkouts: [],
    reason: null,
    environmentId: "env-1",
  });
  expect(calls.map((call) => call.method)).toEqual(["origin"]);
});

test("a repository the thread's machine cannot read is a reason, not a failure", async () => {
  const { ctx, calls } = machines({}, "unreadable");

  expect(await otherMachines.execute(ctx, { threadId: "t1" })).toEqual({
    checkouts: [],
    reason: "No Git repository was found at the environment root or under its repos/ directory.",
    environmentId: "env-1",
  });
  expect(calls.map((call) => call.method)).toEqual(["origin"]);
});
