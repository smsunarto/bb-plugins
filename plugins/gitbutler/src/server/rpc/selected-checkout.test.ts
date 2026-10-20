import { expect, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { checkoutSelectionSchema, type CheckoutIdentity } from "../../shared/schema.ts";
import { baseHistory } from "./base-history.ts";
import { butAction } from "./but-action.ts";
import { conflictResolution } from "./conflict-resolution.ts";
import { oplog } from "./oplog.ts";
import { parkedBranches } from "./parked-branches.ts";
import { patches } from "./patches.ts";
import { requestReview } from "./request-review.ts";
import { resolveConflicts } from "./resolve-conflicts.ts";
import { reviewRequests } from "./review-requests.ts";
import { reviews } from "./reviews.ts";
import { reviewUrl } from "./review-url.ts";
import { workspace } from "./workspace.ts";

const checkout = { hostId: "host-2", path: "/alias/task" };
const observed = { branch: "scott/task", head: "a".repeat(40), origin: "github.com/acme/api" };
const action = { kind: "push" as const, branch: "scott/task", force: false, acceptedLoss: [] };
const scope = {
  threadId: "t1",
  repositoryKey: "repos/api",
  environmentId: "env-1",
  checkout,
  observed,
};

function context() {
  let environment = { id: "env-1", hostId: "host-1", path: "/main", status: "ready" };
  const calls: { method: string; input: Record<string, unknown>; hostId: string }[] = [];
  const spawned: Record<string, unknown>[] = [];
  const sent: unknown[] = [];
  let prepareError: Error | null = null;
  const kv = new Map<string, unknown>();
  const childPaths = new Map<string, string>();
  const children = new Map<string, { status: string; archivedAt: number | null }>();
  const owners: {
    id: string;
    status: string;
    environmentPath: string;
    queuedWork: string;
    archivedAt: number | null;
  }[] = [];
  let origin: string | null = "github.com/acme/api";
  let onOrigin = () => {};
  const identity: CheckoutIdentity = {
    path: "/canonical/task",
    branch: observed.branch,
    head: observed.head,
    origin,
    commonDir: "/canonical/main/.git",
    kind: "git",
  };
  const board = () => ({
    state: "ready",
    reason: null,
    repositoryKey: ".",
    repoName: "api",
    unassignedChanges: [],
    stacks: [],
    base: null,
    upstream: null,
    conflictedFiles: [],
    checkoutIdentity: { ...identity },
  });
  const bb = {
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId === "t1" || threadId === "t2")
            return {
              id: threadId,
              environment,
              environmentId: environment.id,
              projectId: "p1",
              providerId: "codex",
            };
          const child = children.get(threadId);
          if (!child) throw Object.assign(new Error("Not found"), { status: 404 });
          return { ...child, deletedAt: null, queuedMessageCount: 0 };
        },
        list: async ({ archived, offset }: { archived: boolean; offset: number }) => {
          const activeChildren = [...childPaths].map(([id, environmentPath]) => ({
            id,
            environmentPath,
            status: children.get(id)?.status ?? "idle",
            queuedWork: "none",
            archivedAt: children.get(id)?.archivedAt ?? null,
          }));
          return offset
            ? []
            : [...owners, ...activeChildren]
                .filter((owner) => Boolean(owner.archivedAt) === archived)
                .map((owner) =>
                  Object.assign({}, owner, {
                    deletedAt: null,
                    title: "Task owner",
                    titleFallback: null,
                  }),
                );
        },
        spawn: async (input: Record<string, unknown>) => {
          spawned.push(input);
          const id = `child-${spawned.length}`;
          children.set(id, { status: "active", archivedAt: null });
          childPaths.set(id, identity.path);
          return { id };
        },
        send: async (input: unknown) => {
          sent.push(input);
          return {};
        },
      },
      hosts: {
        list: async () => [
          { id: "host-1", name: "Main", status: "connected" },
          { id: "host-2", name: "Build", status: "connected" },
          { id: "offline", name: "Sleeping", status: "disconnected" },
        ],
        get: async () => ({ status: "connected" }),
      },
      projects: { list: async () => [{ sources: [{ hostId: "host-2", path: "/known" }] }] },
      environments: { list: async () => [{ hostId: "host-1", path: "/main" }] },
    },
    hosts: {
      experimental_client: () => ({
        call: async (
          method: string,
          input: Record<string, unknown>,
          options: { hostId: string },
        ) => {
          calls.push({ method, input, hostId: options.hostId });
          if (method === "origin") {
            if (options.hostId === "host-1") onOrigin();
            return {
              path: options.hostId === "host-1" ? "/main/repos/api" : identity.path,
              origin,
            };
          }
          if (input.checkout && input.environmentPath === "/unrelated")
            throw new Error("Checkout is not registered");
          if (method === "workspace") return board();
          if (method === "checkoutIdentity") return { key: ".", identity: { ...identity } };
          if (method === "prepareCheckoutChild") {
            if (prepareError) throw prepareError;
            return { ...identity };
          }
          if (method === "repositories")
            return { repositories: [{ key: ".", name: "api" }], reason: null };
          if (method === "repository") return { key: "repos/api", path: "/main/repos/api" };
          if (method === "butAction") return { result: { status: "done" }, board: board() };
          return {};
        },
      }),
    },
    storage: {
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => void kv.set(key, value),
      },
    },
  } as unknown as BbPluginApi;
  return {
    ctx: { bb } as never,
    calls,
    spawned,
    sent,
    blockPreparation: () => {
      prepareError = new Error("This branch is applied to the main GitButler workspace.");
    },
    owners,
    identity,
    children,
    kv,
    move: () => {
      environment = { ...environment, id: "env-2", path: "/new" };
    },
    withoutOrigin: () => {
      origin = null;
    },
    duringOrigin: (callback: () => void) => {
      onOrigin = callback;
    },
  };
}

const target = {
  environmentPath: "/alias/task",
  repositoryKey: ".",
  checkout: { paths: ["/known"], origin: "github.com/acme/api" },
};

test("selected reads all route through the selected host with server-owned provenance", async () => {
  const scenarios = [
    () => workspace.execute(ctx, { threadId: "t1", repositoryKey: "repos/api", checkout }),
    () =>
      baseHistory.execute(ctx, { threadId: "t1", checkout, from: "abcd", offset: 0, limit: 20 }),
    () => patches.execute(ctx, { threadId: "t1", checkout, source: { kind: "uncommitted" } }),
    () => reviews.execute(ctx, { threadId: "t1", checkout }),
    () => reviewUrl.execute(ctx, { threadId: "t1", checkout, branch: "scott/task" }),
    () => oplog.execute(ctx, { threadId: "t1", checkout }),
    () => parkedBranches.execute(ctx, { threadId: "t1", checkout }),
  ];
  const { ctx, calls } = context();
  for (const read of scenarios) await read();
  const reads = calls.filter(({ method }) => method !== "origin");
  expect(reads.map(({ method }) => method)).toEqual([
    "workspace",
    "baseHistory",
    "patches",
    "reviews",
    "reviewUrl",
    "oplog",
    "parkedBranches",
  ]);
  for (const read of reads) {
    expect(read.hostId).toBe("host-2");
    expect(read.input).toMatchObject(target);
  }
  expect(calls[0]).toEqual({
    method: "origin",
    hostId: "host-1",
    input: {
      environmentPath: "/main",
      repositoryKey: "repos/api",
    },
  });
});

test("selected write preserves parent environment pin, selected host and observed branch tip", async () => {
  const { ctx, calls } = context();
  expect(await butAction.execute(ctx, { ...scope, action })).toMatchObject({
    result: { status: "done" },
    // The board it left, drawn for the checkout's machine.
    workspace: { state: "ready", environmentId: "env-1", hostId: "host-2" },
  });
  // Only the checkout's identity is read before the write, never its whole board.
  expect(calls.map(({ method }) => method)).not.toContain("workspace");
  expect(calls.at(-1)).toEqual({
    method: "butAction",
    hostId: "host-2",
    input: {
      ...target,
      action,
      observed,
      // The host refuses the write if the checkout is no longer there.
      expectedCheckout: { path: "/canonical/task", commonDir: "/canonical/main/.git" },
    },
  });
});

test("a selected board's read tells the next write where the checkout is: one host call", async () => {
  const { ctx, calls } = context();
  await workspace.execute(ctx, { threadId: "t1", repositoryKey: "repos/api", checkout });
  calls.length = 0;
  await butAction.execute(ctx, { ...scope, action });
  expect(calls.map(({ method }) => method)).toEqual(["butAction"]);
  // The subthread records of the board on screen need no host call either.
  await reviewRequests.execute(ctx, { threadId: "t1", repositoryKey: "repos/api", checkout });
  await conflictResolution.execute(ctx, { threadId: "t1", repositoryKey: "repos/api", checkout });
  expect(calls.map(({ method }) => method)).toEqual(["butAction"]);
});

test("browser cannot supply authoritative roots or origin, unknown and offline machines cannot write", async () => {
  expect(() => checkoutSelectionSchema.parse({ ...checkout, paths: ["/unrelated"] })).toThrow();
  expect(() =>
    checkoutSelectionSchema.parse({ ...checkout, origin: "github.com/other/repo" }),
  ).toThrow();
  for (const hostId of ["invented", "offline"]) {
    const { ctx, calls } = context();
    await expect(
      butAction.execute(ctx, { ...scope, checkout: { ...checkout, hostId }, action }),
    ).rejects.toThrow("not connected or has no known checkouts");
    expect(calls).toHaveLength(0);
  }
});

test("unregistered paths, missing origins and moved parent environments refuse before a host mutation", async () => {
  const unknown = context();
  await expect(
    butAction.execute(unknown.ctx, {
      ...scope,
      checkout: { ...checkout, path: "/unrelated" },
      action,
    }),
  ).rejects.toThrow("Checkout is not registered");
  const missing = context();
  missing.withoutOrigin();
  await expect(butAction.execute(missing.ctx, { ...scope, action })).rejects.toThrow("no origin");
  const moved = context();
  moved.duringOrigin(moved.move);
  await expect(butAction.execute(moved.ctx, { ...scope, action })).rejects.toThrow(
    "moved to another environment",
  );
  for (const fixture of [unknown, missing, moved]) {
    expect(fixture.calls.some(({ method }) => method === "butAction")).toBe(false);
  }
});

test("PR and conflict children start at the canonical checkout and actual branch on its machine", async () => {
  const { ctx, spawned, children } = context();
  await requestReview.execute(ctx, { ...scope, branch: "scott/task" });
  children.set("child-1", { status: "idle", archivedAt: null });
  await resolveConflicts.execute(ctx, scope);
  for (const child of spawned)
    expect(child).toMatchObject({
      parentThreadId: "t1",
      projectId: "p1",
      providerId: "codex",
      environment: {
        type: "host",
        hostId: "host-2",
        workspace: {
          type: "unmanaged",
          path: "/canonical/task",
          branch: { kind: "existing", name: "scott/task" },
        },
      },
    });
  expect(spawned[0]?.prompt).toContain("git config --get 'branch.scott/task.merge'");
  expect(spawned[1]?.prompt).toContain("cd '/canonical/task'\ngit status\ngit ls-files -u");
});

test("changed branch or head cannot start work for the board's old snapshot", async () => {
  for (const identity of [
    { branch: "scott/other" },
    { head: "b".repeat(40) },
    { origin: "github.com/other/api" },
  ]) {
    const fixture = context();
    Object.assign(fixture.identity, identity);
    await expect(
      requestReview.execute(fixture.ctx, { ...scope, branch: "scott/task" }),
    ).rejects.toThrow("changed since the board was read");
    expect(fixture.spawned).toHaveLength(0);
  }
});

test("canonical checkout tracking is shared across parent panels and separated from the main checkout", async () => {
  const fixture = context();
  await requestReview.execute(fixture.ctx, { ...scope, branch: "scott/task" });
  expect(
    await requestReview.execute(fixture.ctx, { ...scope, threadId: "t2", branch: "scott/task" }),
  ).toEqual({ threadId: "child-1" });
  fixture.calls.length = 0;
  expect(await reviewRequests.execute(fixture.ctx, { threadId: "t2", checkout })).toEqual({
    requests: [{ branch: "scott/task", threadId: "child-1", running: true }],
  });
  expect(fixture.calls.at(-1)).toEqual({
    method: "checkoutIdentity",
    hostId: "host-2",
    input: target,
  });
  expect(fixture.calls.some(({ method }) => method === "workspace")).toBe(false);
  expect(await reviewRequests.execute(fixture.ctx, { threadId: "t1" })).toEqual({ requests: [] });
  fixture.children.set("child-1", { status: "idle", archivedAt: null });
  await resolveConflicts.execute(fixture.ctx, scope);
  expect(await conflictResolution.execute(fixture.ctx, { threadId: "t2", checkout })).toEqual({
    subthread: { threadId: "child-2", running: true },
  });
  expect(await conflictResolution.execute(fixture.ctx, { threadId: "t1" })).toEqual({
    subthread: null,
  });
  expect(fixture.spawned).toHaveLength(2);
});

test("active, archived-but-running, and queued checkout owners block actions and child spawn", async () => {
  for (const owner of [
    { status: "active", queuedWork: "none", archivedAt: null },
    { status: "stopping", queuedWork: "none", archivedAt: 1 },
    { status: "idle", queuedWork: "waiting", archivedAt: null },
  ]) {
    const fixture = context();
    fixture.owners.push({ id: "owner", environmentPath: "/another-alias/task", ...owner });
    await expect(butAction.execute(fixture.ctx, { ...scope, action })).rejects.toThrow(
      "in use by Task owner (owner)",
    );
    await expect(
      requestReview.execute(fixture.ctx, { ...scope, branch: "scott/task" }),
    ).rejects.toThrow("in use by Task owner");
    expect(fixture.calls.some(({ method }) => method === "butAction")).toBe(false);
    expect(fixture.spawned).toHaveLength(0);
  }
});

test("native child mutations require the observed branch and tip for selected and main checkouts", async () => {
  for (const selection of [checkout, undefined]) {
    const fixture = context();
    await expect(
      requestReview.execute(fixture.ctx, {
        threadId: "t1",
        environmentId: "env-1",
        checkout: selection,
        branch: "scott/task",
      }),
    ).rejects.toThrow("Refresh this checkout before starting work");
    await expect(
      resolveConflicts.execute(fixture.ctx, {
        threadId: "t1",
        environmentId: "env-1",
        checkout: selection,
      }),
    ).rejects.toThrow("Refresh this checkout before starting work");
    expect(fixture.spawned).toHaveLength(0);
  }
});

test("a native main checkout uses Git prompts while retaining the parent's environment", async () => {
  const fixture = context();
  const main = { threadId: "t1", environmentId: "env-1", observed };
  await requestReview.execute(fixture.ctx, { ...main, branch: "scott/task" });
  fixture.children.set("child-1", { status: "idle", archivedAt: null });
  await resolveConflicts.execute(fixture.ctx, main);
  expect(fixture.spawned).toHaveLength(2);
  for (const child of fixture.spawned)
    expect(child.environment).toEqual({ type: "reuse", environmentId: "env-1" });
  expect(fixture.spawned[0]?.prompt).toContain(
    "git push -- <remote> <source-ref>:<destination-ref>",
  );
  expect(fixture.spawned[1]?.prompt).toContain("git ls-files -u");
});

test("a detached native rebase conflict child keeps the exact checkout without switching a branch", async () => {
  const fixture = context();
  fixture.identity.branch = null;
  await resolveConflicts.execute(fixture.ctx, {
    ...scope,
    observed: { ...observed, branch: null },
  });
  expect(fixture.spawned[0]?.environment).toEqual({
    type: "host",
    hostId: "host-2",
    workspace: { type: "unmanaged", path: "/canonical/task" },
  });
  expect(fixture.spawned[0]?.prompt).toContain("git ls-files -u");
});

test("overlapping PR and conflict child requests cannot start two checkout owners", async () => {
  const fixture = context();
  const results = await Promise.allSettled([
    requestReview.execute(fixture.ctx, { ...scope, branch: "scott/task" }),
    resolveConflicts.execute(fixture.ctx, scope),
  ]);
  expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
  const failed = results.find((result) => result.status === "rejected");
  expect(failed?.status === "rejected" ? failed.reason.message : null).toContain(
    "in use by Task owner",
  );
  expect(fixture.spawned).toHaveLength(1);
});

test("native child spawn and resume require the host mutation preflight", async () => {
  const pr = context();
  pr.blockPreparation();
  await expect(requestReview.execute(pr.ctx, { ...scope, branch: "scott/task" })).rejects.toThrow(
    "applied to the main GitButler workspace",
  );
  expect(pr.spawned).toHaveLength(0);
  expect(pr.calls.find(({ method }) => method === "prepareCheckoutChild")).toEqual({
    method: "prepareCheckoutChild",
    hostId: "host-2",
    input: { ...target, kind: "review", observed },
  });
  const conflicts = context();
  await resolveConflicts.execute(conflicts.ctx, scope);
  conflicts.children.set("child-1", { status: "idle", archivedAt: null });
  conflicts.blockPreparation();
  await expect(resolveConflicts.execute(conflicts.ctx, scope)).rejects.toThrow(
    "applied to the main GitButler workspace",
  );
  expect(conflicts.spawned).toHaveLength(1);
  expect(conflicts.sent).toHaveLength(0);
});
