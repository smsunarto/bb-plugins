// @vitest-environment jsdom
import { act, cleanup, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Branch, ThreadChange, WorkspaceValue } from "../core/change.ts";
import { changeKeySchema } from "../core/ids.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { writeSnapshot } from "./snapshot.ts";

const app = await loadPluginApp(() => import("./app.tsx"));
type ThreadTab = {
  component: ComponentType<{ threadId: string; environment: { id: string } | null }>;
};
const tab = app.tabs.find((registration) => registration.id === "changes") as unknown as ThreadTab;

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function branchOf(name: string, overrides: Partial<Branch> = {}): Branch {
  return {
    name,
    head: "c0ffee1",
    remote: { ref: `origin/${name}`, name },
    status: "ahead",
    push: "push",
    ahead: 1,
    behind: 0,
    newUpstream: 0,
    reviewId: null,
    commits: [
      {
        id: "c0ffee1",
        subject: "Move the gh client to the host entry",
        createdAt: iso(60),
        conflicted: false,
      },
    ],
    moreCommits: 0,
    upstreamCommits: [],
    ...overrides,
  };
}

function local(branch: string, overrides: Partial<WorkspaceValue> = {}): WorkspaceValue {
  return {
    provider: "gitbutler",
    path: `/work/${branch}`,
    commonDir: `/work/${branch}/.git`,
    checkedOut: null,
    github: { repo: { owner: "smsunarto", name: "bb-plugins" }, headOwner: "smsunarto" },
    uncommitted: [{ path: "src/host/host.ts", kind: "modified" }],
    moreUncommitted: 0,
    conflicted: [],
    stacks: [{ key: branch, branches: [branchOf(branch)], assigned: [] }],
    target: {
      ref: "origin/main",
      head: "a41c9e2ffff",
      behind: 2,
      base: { id: "a41c9e2aaaa", subject: "Base" },
      lastFetched: null,
    },
    ...overrides,
  };
}

function checkout(
  branch: string,
  title: string | null,
  overrides: Partial<Extract<ThreadChange, { state: "checkout" }>> = {},
): ThreadChange {
  return {
    state: "checkout",
    placement: {
      hostId: "host-a",
      hostName: "studio-mac",
      path: `/work/${branch}`,
      environmentId: "env",
    },
    readAsGit: false,
    branch,
    key: changeKeySchema.parse(`gh:smsunarto/bb-plugins:smsunarto:${branch}`),
    local: { read: { value: local(branch), at: Date.now() - 12 * 60_000 }, problem: null },
    forge: {
      read: {
        value: title
          ? {
              number: 482,
              url: "https://github.com/x",
              title,
              state: "open",
              isDraft: true,
              headRefOid: "c0ffee",
              baseRef: "main",
              reviewDecision: null,
              approvals: 0,
              checks: { passed: 4, failed: 0, pending: 0 },
            }
          : null,
        at: Date.now(),
      },
      problem: null,
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

test("the last snapshot paints while the read is still pending", async () => {
  writeSnapshot("thread-a", checkout("scott/route-gh", "Route gh through the checkout host"));
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    {
      experimental_rpcContract: sourceControlContract,
      rpc: {
        changeForThread: () => new Promise(() => {}),
        refreshThread: () => ({ ok: true as const }),
      },
    },
  );
  expect(await slot.findByText("Route gh through the checkout host")).toBeTruthy();
  expect(slot.getByTestId("sc-read-state").textContent).toBe("Read 12 min ago");
});

test("with neither data nor snapshot, the loading skeleton reserves the layout", async () => {
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    {
      experimental_rpcContract: sourceControlContract,
      rpc: {
        changeForThread: () => new Promise(() => {}),
        refreshThread: () => ({ ok: true as const }),
      },
    },
  );
  expect(slot.getByTestId("sc-loading")).toBeTruthy();
  expect(slot.getByTestId("sc-read-state").textContent).toBe("Reading…");
});

test("a late answer for thread A is never drawn in thread B's pane", async () => {
  const answers = { "thread-a": deferred<ThreadChange>(), "thread-b": deferred<ThreadChange>() };
  const rpc = {
    changeForThread: async (input: unknown) => {
      const { keys } = input as { keys: (keyof typeof answers)[] };
      return Object.fromEntries(
        await Promise.all(keys.map(async (key) => [key, await answers[key].promise] as const)),
      );
    },
    refreshThread: () => ({ ok: true as const }),
  };
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    { experimental_rpcContract: sourceControlContract, rpc },
  );
  const Tab = tab.component;
  slot.lifecycle.rerender(<Tab threadId="thread-b" environment={{ id: "env" }} />);
  // A answers after the pane moved to B, while B is still reading.
  await act(async () => answers["thread-a"].resolve(checkout("scott/a", "Change A")));
  await new Promise((settle) => setTimeout(settle, 20));
  expect(slot.queryByText("Change A")).toBeNull();
  expect(slot.getByTestId("sc-loading")).toBeTruthy();
  await act(async () => answers["thread-b"].resolve(checkout("scott/b", "Change B")));
  expect(await slot.findByText("Change B")).toBeTruthy();
  expect(slot.queryByText("Change A")).toBeNull();
});

test("switching from A to B shows B reading, never A's Change", async () => {
  const b = deferred<ThreadChange>();
  const rpc = {
    changeForThread: async (input: unknown) => {
      const { keys } = input as { keys: string[] };
      return Object.fromEntries(
        await Promise.all(
          keys.map(
            async (key) =>
              [
                key,
                key === "thread-a" ? checkout("scott/a", "Change A") : await b.promise,
              ] as const,
          ),
        ),
      );
    },
    refreshThread: () => ({ ok: true as const }),
  };
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    { experimental_rpcContract: sourceControlContract, rpc },
  );
  expect(await slot.findByText("Change A")).toBeTruthy();
  const Tab = tab.component;
  slot.lifecycle.rerender(<Tab threadId="thread-b" environment={{ id: "env" }} />);
  await new Promise((settle) => setTimeout(settle, 20));
  expect(slot.queryByText("Change A")).toBeNull();
  expect(slot.getByTestId("sc-loading")).toBeTruthy();
  await act(async () => b.resolve(checkout("scott/b", "Change B")));
  expect(await slot.findByText("Change B")).toBeTruthy();
});

test("offline keeps the last read and says which host is not answering", async () => {
  const row = checkout("scott/route-gh", "Route gh through the checkout host", {});
  if (row.state !== "checkout") throw new Error("fixture");
  row.local.problem = { kind: "host-offline", host: "studio-mac" };
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    {
      experimental_rpcContract: sourceControlContract,
      rpc: {
        changeForThread: () => ({ "thread-a": row }),
        refreshThread: () => ({ ok: true as const }),
      },
    },
  );
  expect((await slot.findByTestId("sc-stale")).textContent).toContain(
    "studio-mac is not answering",
  );
  expect(slot.getByText("Route gh through the checkout host")).toBeTruthy();
  expect(slot.getByTestId("sc-read-state").textContent).toBe("Read 12 min ago");
});

test("a failed first read says what broke and retries only when asked", async () => {
  let refreshes = 0;
  const row: ThreadChange = {
    state: "checkout",
    placement: { hostId: "host-b", hostName: "build-linux", path: "/w", environmentId: "env" },
    readAsGit: false,
    branch: null,
    key: null,
    local: {
      read: null,
      problem: {
        kind: "tool-missing",
        tool: "git",
        host: "build-linux",
        detail: "git: command not found",
      },
    },
    forge: { read: null, problem: null },
  };
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    {
      experimental_rpcContract: sourceControlContract,
      rpc: {
        changeForThread: () => ({ "thread-a": row }),
        refreshThread: () => (refreshes++, { ok: true as const }),
      },
    },
  );
  expect((await slot.findByTestId("sc-failed")).textContent).toContain("build-linux has no git");
  expect(refreshes).toBe(0);
  await act(async () => slot.getByRole("button", { name: "Try again" }).click());
  await waitFor(() => expect(refreshes).toBe(1));
});

test("a first read that finds the host asleep does not claim a last read", async () => {
  const row: ThreadChange = {
    state: "checkout",
    placement: { hostId: "host-a", hostName: "dev-pc", path: "/w", environmentId: "env" },
    readAsGit: false,
    branch: null,
    key: null,
    local: { read: null, problem: { kind: "host-offline", host: "dev-pc" } },
    forge: { read: null, problem: null },
  };
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    {
      experimental_rpcContract: sourceControlContract,
      rpc: {
        changeForThread: () => ({ "thread-a": row }),
        refreshThread: () => ({ ok: true as const }),
      },
    },
  );
  const failed = await slot.findByTestId("sc-failed");
  expect(failed.textContent).toContain("dev-pc is not answering.");
  expect(failed.textContent).not.toContain("last read");
});

type Rpc = Parameters<typeof renderSlot<typeof sourceControlContract>>[2] extends infer O
  ? O extends { rpc?: infer R }
    ? NonNullable<R>
    : never
  : never;

/** Renders the tab over `row`, with every write and read recorded. */
function renderRow(row: ThreadChange, rpc: Partial<Rpc> = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const record =
    <T,>(method: string, answer: (input: never) => T) =>
    (input: unknown) => {
      calls.push({ method, input });
      return answer(input as never);
    };
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    {
      experimental_rpcContract: sourceControlContract,
      rpc: {
        changeForThread: () => ({ "thread-a": row }),
        refreshThread: record("refreshThread", () => ({ ok: true as const })),
        setReadAs: record("setReadAs", () => ({ ok: true as const })),
        vcsAction: record("vcsAction", rpc.vcsAction ?? (() => ({ status: "done" as const }))),
        patches: record(
          "patches",
          rpc.patches ?? (() => ({ ok: true as const, value: { files: [] } })),
        ),
      } as Rpc,
    },
  );
  const of = (method: string) => calls.filter((call) => call.method === method);
  return { slot, calls, of };
}

function stacked(): ThreadChange {
  const row = checkout("scott/forge-host", "Route gh through the checkout host");
  if (row.state !== "checkout" || !row.local.read) throw new Error("fixture");
  row.local.read.value = local("scott/forge-host", {
    stacks: [
      {
        key: "scott/core-schema",
        branches: [
          branchOf("scott/forge-host", {
            head: "f00d001",
            commits: [
              {
                id: "f00d001",
                subject: "Route server reads to the owning host",
                createdAt: iso(38),
                conflicted: false,
              },
              {
                id: "f00d002",
                subject: "Share one pull request schema",
                createdAt: iso(180),
                conflicted: false,
              },
            ],
          }),
          branchOf("scott/core-schema", {
            head: "beef001",
            status: "pushed",
            push: "none",
            ahead: 0,
            reviewId: "#481",
            commits: [
              {
                id: "beef001",
                subject: "Add the core schema",
                createdAt: iso(300),
                conflicted: false,
              },
            ],
          }),
        ],
        assigned: [],
      },
    ],
  });
  return row;
}

test("the tab is registered as Source Control", () => {
  expect((tab as unknown as { title: string }).title).toBe("Source Control");
});

test("stack cards draw each branch and its commits, and the base under them", async () => {
  const { slot } = renderRow(stacked());
  const branches = await slot.findAllByTestId("sc-branch");
  expect(branches.map((card) => card.getAttribute("aria-label"))).toEqual([
    "Branch scott/forge-host",
    "Branch scott/core-schema",
  ]);
  expect(slot.getByText("Stack · 2 branches")).toBeTruthy();
  expect(branches[0]!.textContent).toContain("Route server reads to the owning host");
  expect(branches[0]!.textContent).toContain("Share one pull request schema");
  expect(branches[0]!.textContent).toContain("#482 Draft");
  expect(branches[1]!.textContent).toContain("Add the core schema");
  expect(branches[1]!.textContent).toContain("#481");
  expect(slot.getByTestId("sc-behind").textContent).toBe("main has 2 new commits");
  expect(slot.getByTestId("sc-base").textContent).toContain("origin/main");
  expect(slot.getByTestId("sc-base").textContent).toContain("a41c9e2");
});

test("Push names the head and target the reader saw", async () => {
  const { slot, of } = renderRow(stacked());
  await act(async () =>
    (await slot.findByRole("button", { name: "Push scott/forge-host" })).click(),
  );
  await waitFor(() => expect(of("vcsAction")).toHaveLength(1));
  expect(of("vcsAction")[0]!.input).toEqual({
    threadId: "thread-a",
    action: { kind: "push", branch: "scott/forge-host", force: false, acceptedLoss: [] },
    expected: { head: "f00d001", target: "a41c9e2ffff" },
  });
});

test("a conflict says the checkout moved and is never retried", async () => {
  const { slot, of } = renderRow(stacked(), {
    vcsAction: () => ({ status: "conflict" as const, detail: "head moved" }),
  });
  await act(async () =>
    (await slot.findByRole("button", { name: "Push scott/forge-host" })).click(),
  );
  expect(await slot.findByText("The checkout changed since you looked.")).toBeTruthy();
  await new Promise((settle) => setTimeout(settle, 30));
  expect(of("vcsAction")).toHaveLength(1);
});

test("a force-push question waits for the reader, then sends the loss they accepted", async () => {
  let answers = 0;
  const { slot, of } = renderRow(stacked(), {
    vcsAction: () =>
      answers++ === 0
        ? { status: "confirm" as const, risk: null, loss: ["dead001", "dead002"] }
        : { status: "done" as const },
  });
  await act(async () =>
    (await slot.findByRole("button", { name: "Push scott/forge-host" })).click(),
  );
  expect(await slot.findByText(/the 2 upstream commits/)).toBeTruthy();
  await new Promise((settle) => setTimeout(settle, 30));
  expect(of("vcsAction")).toHaveLength(1);
  await act(async () => slot.getByRole("button", { name: "Push" }).click());
  await waitFor(() => expect(of("vcsAction")).toHaveLength(2));
  expect(of("vcsAction")[1]!.input).toMatchObject({
    action: { kind: "push", branch: "scott/forge-host", acceptedLoss: ["dead001", "dead002"] },
    expected: { head: "f00d001", target: "a41c9e2ffff" },
  });
});

test("a workspace with no GitButler CLI offers to read again or read as plain git", async () => {
  const row: ThreadChange = {
    state: "checkout",
    placement: { hostId: "host-a", hostName: "dev-pc", path: "/w", environmentId: "env" },
    readAsGit: false,
    branch: null,
    key: null,
    local: {
      read: null,
      problem: { kind: "tool-missing", tool: "but", host: "dev-pc", detail: "but: not found" },
    },
    forge: { read: null, problem: null },
  };
  const { slot, of } = renderRow(row);
  expect((await slot.findByTestId("sc-failed")).textContent).toContain("no GitButler CLI");
  await act(async () => slot.getByRole("button", { name: "Try again" }).click());
  await waitFor(() => expect(of("refreshThread")).toHaveLength(1));
  await act(async () => slot.getByRole("button", { name: "Read as plain git" }).click());
  await waitFor(() => expect(of("setReadAs")).toHaveLength(1));
  expect(of("setReadAs")[0]!.input).toEqual({ threadId: "thread-a", readAs: "git" });
});

test("a GitButler CLI gone after a good read keeps the read and still offers plain git", async () => {
  const row = stacked();
  if (row.state !== "checkout") throw new Error("fixture");
  row.local = {
    ...row.local,
    problem: { kind: "tool-missing", tool: "but", host: "dev-pc", detail: "but: not found" },
  };
  const { slot, of } = renderRow(row);
  expect((await slot.findByTestId("sc-stale")).textContent).toContain("no GitButler CLI");
  expect(slot.getByTestId("sc-ready")).toBeTruthy();
  await act(async () => slot.getByRole("button", { name: "Read as plain git" }).click());
  await waitFor(() =>
    expect(of("setReadAs")[0]?.input).toEqual({ threadId: "thread-a", readAs: "git" }),
  );
});

test("a workspace read as plain git can be read as GitButler again", async () => {
  const row = stacked();
  if (row.state !== "checkout") throw new Error("fixture");
  row.readAsGit = true;
  const { slot, of } = renderRow(row);
  const restore = await slot.findByRole("button", { name: "Read as GitButler" });
  // GitButler's own branch is not the reader's to push or land.
  expect(slot.queryByRole("button", { name: "Push" })).toBeNull();
  expect(slot.queryByRole("button", { name: /^Land/ })).toBeNull();
  expect(slot.queryByRole("button", { name: /^Pull/ })).toBeNull();
  await act(async () => restore.click());
  await waitFor(() =>
    expect(of("setReadAs")[0]?.input).toEqual({ threadId: "thread-a", readAs: "auto" }),
  );
});

test("opening a commit reads that commit's files, and only then", async () => {
  const { slot, of } = renderRow(stacked(), {
    patches: () => ({
      ok: true as const,
      value: {
        files: [
          {
            path: "src/server/router.ts",
            kind: "modified" as const,
            previousPath: null,
            patch: "",
            truncated: false,
          },
        ],
      },
    }),
  });
  const commit = await slot.findByRole("button", { name: /Route server reads to the owning host/ });
  expect(of("patches")).toHaveLength(0);
  await act(async () => commit.click());
  expect(await slot.findByText("router.ts")).toBeTruthy();
  expect(of("patches").map((call) => call.input)).toEqual([
    { threadId: "thread-a", source: { kind: "commit", commitId: "f00d001" } },
  ]);
});

test("an offline header keeps the last read's age, not now", async () => {
  const row = checkout("scott/route-gh", "Route gh through the checkout host");
  if (row.state !== "checkout" || !row.local.read) throw new Error("fixture");
  row.local.read.at = Date.now() - 12 * 60_000;
  row.local.problem = { kind: "host-offline", host: "dev-pc" };
  const { slot } = renderRow(row);
  expect((await slot.findByTestId("sc-stale")).textContent).toContain("dev-pc is not answering");
  expect(slot.getByTestId("sc-read-state").textContent).toBe("Read 12 min ago");
});

test("opening an uncommitted file reads the uncommitted patches, and only then", async () => {
  const { slot, of } = renderRow(stacked());
  const file = await slot.findByRole("button", { name: /host\.ts/ });
  expect(of("patches")).toHaveLength(0);
  await act(async () => file.click());
  await waitFor(() => expect(of("patches")).toHaveLength(1));
  expect(of("patches")[0]!.input).toEqual({
    threadId: "thread-a",
    source: { kind: "uncommitted" },
  });
  expect(await slot.findByText(/no uncommitted change now/)).toBeTruthy();
});
