// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, type ComponentType } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Branch, ThreadChange, WorkspaceValue } from "../core/change.ts";
import { changeKeySchema } from "../core/ids.ts";
import { reviewPath } from "../core/review.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { offlineReason } from "./host-gate.ts";
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
              mergeable: "mergeable",
              additions: 412,
              deletions: 96,
              changedFiles: 14,
              commits: 3,
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
        forgeAction: record(
          "forgeAction",
          rpc.forgeAction ?? (() => ({ status: "done" as const })),
        ),
        createPullRequest: record(
          "createPullRequest",
          rpc.createPullRequest ?? (() => ({ ok: true as const, threadId: "pr-child" })),
        ),
        publishRequests: record(
          "publishRequests",
          rpc.publishRequests ?? (() => ({ requests: [] })),
        ),
        oplog: record(
          "oplog",
          rpc.oplog ??
            (() => ({
              ok: true as const,
              value: {
                entries: [
                  {
                    id: "22c2d57fb4e93d0fbb45aad16aea1b513b6596d5",
                    operation: "CreateCommit",
                    title: "CreateCommit",
                    body: null,
                    createdAt: iso(5),
                  },
                ],
              },
            })),
        ),
        mergePolicy: record(
          "mergePolicy",
          rpc.mergePolicy ?? (() => ({ ok: true as const, policy: POLICY })),
        ),
      } as Rpc,
    },
  );
  const of = (method: string) => calls.filter((call) => call.method === method);
  return { slot, calls, of };
}

const POLICY = {
  state: "OPEN" as const,
  isDraft: false,
  headRefOid: "c0ffee",
  baseRefName: "main",
  mergeStateStatus: "CLEAN",
  canMerge: true,
  methods: ["merge" as const, "squash" as const],
};

/** `stacked()` with its pull request open and ready. */
function readyToMerge(): ThreadChange {
  const row = stacked();
  if (row.state !== "checkout" || !row.forge.read?.value) throw new Error("fixture");
  row.forge.read.value = { ...row.forge.read.value, isDraft: false };
  return row;
}

// jsdom lacks what Radix Select calls as it opens and scrolls to the chosen option.
Element.prototype.scrollIntoView ??= function () {};
Element.prototype.hasPointerCapture ??= () => false;

/** Picks `name` from a Select, as a keyboard reader does: Enter opens it, Enter on the option chooses. */
async function choose(trigger: HTMLElement, name: string) {
  act(() => {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  const option = await screen.findByRole("option", { name });
  act(() => {
    option.focus();
    fireEvent.keyDown(option, { key: "Enter" });
  });
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
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

test("Delete asks first, sends nothing until confirmed, then asks again about uncommitted overlap", async () => {
  let answers = 0;
  const risk = { conflicted: [], overlapsUncommitted: true };
  const { slot, of } = renderRow(stacked(), {
    vcsAction: () =>
      answers++ === 0
        ? { status: "confirm" as const, risk, loss: null }
        : { status: "done" as const },
  });
  await act(async () =>
    (await slot.findByRole("button", { name: "Delete scott/forge-host" })).click(),
  );
  expect(await slot.findByText(/The remote branch and any PR stay/)).toBeTruthy();
  // The branch above it moves down: scott/forge-host is the top of a two-branch stack.
  expect(of("vcsAction")).toHaveLength(0);
  await act(async () => slot.getByRole("button", { name: "Delete" }).click());
  await waitFor(() => expect(of("vcsAction")).toHaveLength(1));
  expect(of("vcsAction")[0]!.input).toEqual({
    threadId: "thread-a",
    action: { kind: "delete", branch: "scott/forge-host", accepted: null },
    expected: { head: "f00d001", target: "a41c9e2ffff" },
  });
  expect(await slot.findByText(/writes conflict markers into them/)).toBeTruthy();
  await act(async () => slot.getByRole("button", { name: "Delete anyway" }).click());
  await waitFor(() => expect(of("vcsAction")).toHaveLength(2));
  expect(of("vcsAction")[1]!.input).toMatchObject({
    action: { kind: "delete", branch: "scott/forge-host", accepted: risk },
  });
});

test("Rename asks for a valid new name, then renames pinned to the head the reader saw, once", async () => {
  const { slot, of } = renderRow(stacked(), {
    vcsAction: () => ({ status: "conflict" as const, detail: "scott/forge-host moved." }),
  });
  await act(async () =>
    (await slot.findByRole("button", { name: "Rename scott/forge-host" })).click(),
  );
  const field = (await slot.findByRole("textbox", {
    name: "New name for scott/forge-host",
  })) as HTMLInputElement;
  const confirm = slot.getByRole("button", { name: "Rename" }) as HTMLButtonElement;
  // The name takes focus, not Cancel, so the reader types straight away.
  expect(document.activeElement).toBe(field);
  // The unchanged name, or one git would refuse, cannot be sent.
  expect(confirm.disabled).toBe(true);
  fireEvent.change(field, { target: { value: "has space" } });
  expect(confirm.disabled).toBe(true);
  fireEvent.change(field, { target: { value: "scott/forge-host-2" } });
  expect(confirm.disabled).toBe(false);
  await act(async () => confirm.click());
  await waitFor(() => expect(of("vcsAction")).toHaveLength(1));
  expect(of("vcsAction")[0]!.input).toEqual({
    threadId: "thread-a",
    action: { kind: "rename", branch: "scott/forge-host", name: "scott/forge-host-2" },
    expected: { head: "f00d001", target: "a41c9e2ffff" },
  });
  // A refusal is shown, not retried.
  await waitFor(() => expect(slot.getByRole("alert").textContent).toBeTruthy());
  expect(of("vcsAction")).toHaveLength(1);
});

test("Merge reads the policy fresh, then merges pinned to the head and base the reader saw", async () => {
  const { slot, of } = renderRow(readyToMerge());
  await act(async () => (await slot.findByRole("button", { name: "Merge #482" })).click());
  const confirm = await slot.findByTestId("sc-merge-confirm");
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  expect(of("mergePolicy")[0]!.input).toEqual({
    key: "gh:smsunarto/bb-plugins:smsunarto:scott/forge-host",
    number: 482,
  });
  // Squash is allowed, so the dialog starts there.
  expect(confirm.textContent).toBe("Squash and merge");
  const select = slot.getByTestId("sc-merge-method");
  await choose(select, "Create a merge commit");
  expect(confirm.textContent).toBe("Create a merge commit");
  await act(async () => (confirm as HTMLButtonElement).click());
  await waitFor(() => expect(of("forgeAction")).toHaveLength(1));
  expect(of("forgeAction")[0]!.input).toEqual({
    threadId: "thread-a",
    action: { kind: "merge", method: "merge", base: "main" },
    expected: { number: 482, head: "c0ffee" },
  });
  await waitFor(() => expect(slot.queryByTestId("sc-merge-dialog")).toBeNull());
});

test("Escape closes the merge dialog and returns focus to Merge, never leaving the page", async () => {
  const left: string[] = [];
  const leave = (event: KeyboardEvent) => {
    if (event.key === "Escape") left.push(event.key);
  };
  document.addEventListener("keydown", leave);
  const { slot } = renderRow(readyToMerge());
  const opener = await slot.findByRole("button", { name: "Merge #482" });
  await act(async () => opener.click());
  expect(screen.getByRole("dialog", { name: "Merge pull request" })).toBeTruthy();
  act(() => void fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
  await waitFor(() => expect(slot.queryByTestId("sc-merge-dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(left).toEqual([]);
  document.removeEventListener("keydown", leave);
});

test("Merge stays off with GitHub's reason, and a failed merge is reported, not retried", async () => {
  const blocked = renderRow(readyToMerge(), {
    mergePolicy: () => ({ ok: true as const, policy: { ...POLICY, mergeStateStatus: "BLOCKED" } }),
  });
  await act(async () => (await blocked.slot.findByRole("button", { name: "Merge #482" })).click());
  expect((await blocked.slot.findByTestId("sc-merge-issue")).textContent).toContain(
    "GitHub blocks merging: BLOCKED",
  );
  expect((blocked.slot.getByTestId("sc-merge-confirm") as HTMLButtonElement).disabled).toBe(true);
  cleanup();

  const { slot, of } = renderRow(readyToMerge(), {
    forgeAction: () => ({
      status: "failed" as const,
      problem: { kind: "failed" as const, site: "GitHub", detail: "Head branch was modified." },
    }),
  });
  await act(async () => (await slot.findByRole("button", { name: "Merge #482" })).click());
  const confirm = (await slot.findByTestId("sc-merge-confirm")) as HTMLButtonElement;
  await waitFor(() => expect(confirm.disabled).toBe(false));
  await act(async () => confirm.click());
  expect(await slot.findByText(/Head branch was modified\. Refreshing/)).toBeTruthy();
  await new Promise((settle) => setTimeout(settle, 30));
  expect(of("forgeAction")).toHaveLength(1);
  // The requirements are read again before another try.
  expect(of("mergePolicy").length).toBeGreaterThanOrEqual(2);
});

test("Create PR on the thread's branch with no pull request names the head seen, then shows its child", async () => {
  const row = stacked();
  if (row.state !== "checkout") throw new Error("fixture");
  row.forge = { read: { value: null, at: Date.now() }, problem: null };
  let started = false;
  const { slot, of } = renderRow(row, {
    createPullRequest: () => {
      started = true;
      return { ok: true as const, threadId: "pr-child" };
    },
    publishRequests: () => ({
      requests: started
        ? [{ branch: "scott/forge-host", threadId: "pr-child", running: true }]
        : [],
    }),
  });
  await act(async () =>
    (await slot.findByRole("button", { name: "Create PR for scott/forge-host" })).click(),
  );
  await waitFor(() => expect(of("createPullRequest")).toHaveLength(1));
  expect(of("createPullRequest")[0]!.input).toEqual({
    threadId: "thread-a",
    branch: "scott/forge-host",
    head: "f00d001",
  });
  expect((await slot.findByTestId("sc-create-pr-status")).textContent).toContain(
    "A subthread is writing and opening the PR.",
  );
  // Only the thread's own branch gets it; the branch below has no pull request read.
  expect(slot.queryByRole("button", { name: "Create PR for scott/core-schema" })).toBeNull();
});

test("Commit sends the files the reader sees, onto the chosen branch at the head seen", async () => {
  const { slot, of } = renderRow(stacked());
  await act(async () => (await slot.findByTestId("sc-commit-open")).click());
  const field = slot.getByTestId("sc-commit-message") as HTMLTextAreaElement;
  expect(document.activeElement).toBe(field);
  const confirm = slot.getByTestId("sc-commit-confirm") as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field, "fix: route reads");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const select = slot.getByTestId("sc-commit-branch");
  expect(select.textContent).toBe("scott/forge-host");
  await choose(select, "scott/core-schema");
  expect(select.textContent).toBe("scott/core-schema");
  await act(async () => confirm.click());
  await waitFor(() => expect(of("vcsAction")).toHaveLength(1));
  expect(of("vcsAction")[0]!.input).toEqual({
    threadId: "thread-a",
    action: {
      kind: "commit",
      branch: "scott/core-schema",
      message: "fix: route reads",
      paths: ["src/host/host.ts"],
    },
    expected: { head: "beef001", target: "a41c9e2ffff" },
  });
});

test("a draft pull request has no Merge", async () => {
  const { slot } = renderRow(stacked());
  await slot.findByRole("button", { name: "Push scott/forge-host" });
  expect(slot.queryByRole("button", { name: "Merge #482" })).toBeNull();
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

test("a commit's open file jumps to the review page at that commit and file", async () => {
  const { slot } = renderRow(stacked(), {
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
  await act(async () =>
    (await slot.findByRole("button", { name: /Route server reads to the owning host/ })).click(),
  );
  await act(async () => (await slot.findByText("router.ts")).click());
  await act(async () => (await slot.findByTestId("sc-review-jump")).click());
  // The commit is on the thread's own branch, so the jump takes the row's key.
  expect(slot.navigateCalls.at(-1)).toMatchObject({
    method: "toPluginPanel",
    path: "source-control",
    options: {
      subPath: reviewPath({
        key: changeKeySchema.parse("gh:smsunarto/bb-plugins:smsunarto:scott/forge-host"),
        tab: "commits",
        commit: "f00d001",
        path: "src/server/router.ts",
      }),
    },
  });
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

// ── Status everywhere ──────────────────────────────────────────────────

const segment = app.threadContextSegments.find((registration) => registration.id === "change")!;

/** Board B's change: a draft #482 with 2 checks running, 9 passed, and 3 files uncommitted. */
function boardB(): ThreadChange {
  const row = checkout("scott/forge-host", "Route gh through the checkout host");
  if (row.state !== "checkout" || !row.local.read || !row.forge.read?.value)
    throw new Error("fixture");
  row.local.read.value = local("scott/forge-host", {
    uncommitted: [
      { path: "a.ts", kind: "modified" },
      { path: "b.ts", kind: "modified" },
      { path: "c.ts", kind: "added" },
    ],
    stacks: [
      {
        key: "scott/forge-host",
        branches: [branchOf("scott/forge-host", { status: "pushed", push: "none", ahead: 0 })],
        assigned: [],
      },
    ],
  });
  row.forge.read.value = { ...row.forge.read.value, checks: { passed: 9, failed: 0, pending: 2 } };
  return row;
}

function renderStrip(row: ThreadChange, segments: { key: string; pluginId: string }[] = []) {
  const forgeCalls: unknown[] = [];
  const shipCalls: unknown[] = [];
  const props = {
    threadId: "thread-a",
    projectId: "proj",
    environment: { id: "env" },
    segments: [{ key: "source-control/change", pluginId: "source-control" }, ...segments],
    isExpanded: false,
    onToggle: () => undefined,
  };
  const options = {
    experimental_rpcContract: sourceControlContract,
    rpc: {
      changeForThread: () => ({ "thread-a": row }),
      forgeAction: (input: unknown) => {
        forgeCalls.push(input);
        return { status: "done" as const };
      },
      shipThread: (input: unknown) => {
        shipCalls.push(input);
        return { ok: true as const };
      },
    } as Rpc,
  };
  return {
    summary: renderSlot({ component: segment.summary }, props, options),
    action: renderSlot({ component: segment.action! }, props, options),
    forgeCalls,
    shipCalls,
  };
}

test("strip, tab header and the sidebar's row say the same for one Change", async () => {
  const { threadStatus } = await import("../core/status.ts");
  const row = boardB();
  const { slot } = renderRow(row);
  const strip = renderStrip(row);

  // The tab header, as board B heads it: state and title, then branch, number, commits and size.
  // The ship path is the review page's; the forge line would repeat the chip.
  const line = await slot.findByTestId("sc-local-line");
  expect(line.textContent).toContain("· #482 · 3 commits");
  expect(line.textContent).toContain("+412−96");
  expect(slot.queryByTestId("sc-ship-path")).toBeNull();
  expect(slot.queryByTestId("sc-forge-line")?.textContent ?? "").not.toMatch(/#482|checks/);
  expect(slot.getByRole("link", { name: "Open #482 on GitHub" })).toBeTruthy();
  expect(slot.getByTestId("sc-chips").textContent).toBe("2 Running");

  // The strip: board B's words.
  expect((await strip.summary.findByTestId("sc-strip")).textContent).toBe(
    "Draft #4822 checks running3 uncommitted",
  );
  expect(await strip.action.findByTestId("sc-strip-mark-ready")).toBeTruthy();

  // The sidebar's row is the same derivation, served by statusForThread.
  const status = threadStatus(row);
  expect(status).toMatchObject({
    state: "change",
    pullRequest: { number: 482, state: "draft" },
    line: "Draft · 2 checks running",
    chips: [{ label: "2 Running", tone: "warning" }],
  });
  expect(slot.getByTestId("sc-pr-chip").textContent).toBe("Draft");
});

test("the pull request chip's menu marks a draft ready, and Escape closes the menu, not the page", async () => {
  const left: string[] = [];
  const leave = (event: KeyboardEvent) => {
    if (event.key === "Escape") left.push(event.key);
  };
  document.addEventListener("keydown", leave);
  const { slot, of } = renderRow(boardB());
  const chip = await slot.findByTestId("sc-pr-chip");
  act(() => {
    chip.focus();
    fireEvent.keyDown(chip, { key: "Enter" });
  });
  expect(screen.getByRole("menuitem", { name: "Mark ready for review" })).toBeTruthy();
  act(() => void fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(left).toEqual([]);
  document.removeEventListener("keydown", leave);

  act(() => {
    chip.focus();
    fireEvent.keyDown(chip, { key: "Enter" });
  });
  const item = screen.getByTestId("sc-draft-toggle");
  act(() => {
    item.focus();
    fireEvent.keyDown(item, { key: "Enter" });
  });
  await waitFor(() => expect(of("forgeAction")).toHaveLength(1));
  expect(of("forgeAction")[0]!.input).toMatchObject({ action: { kind: "setDraft", draft: false } });
  expect(screen.queryByRole("menu")).toBeNull();
});

test("a pull request that conflicts with its base says so before its failed checks, everywhere", async () => {
  const { threadStatus } = await import("../core/status.ts");
  const row = boardB();
  if (row.state !== "checkout" || !row.forge.read?.value) throw new Error("fixture");
  row.forge.read.value = {
    ...row.forge.read.value,
    number: 156,
    isDraft: false,
    mergeable: "conflicting",
    checks: { passed: 5, failed: 4, pending: 0 },
  };
  const { slot } = renderRow(row);
  const strip = renderStrip(row, [{ key: "bb--git/changed-files", pluginId: "bb--git" }]);
  expect((await strip.summary.findByTestId("sc-strip")).textContent).toBe(
    "Open #156Conflicts with main4 checks failed",
  );
  expect((await slot.findByTestId("sc-chips")).textContent).toBe("Conflicts4 Failed");
  expect(threadStatus(row)).toMatchObject({ line: "Conflicts with main", sort: 0 });
});

test("the strip leaves the uncommitted count to bb's own changed-files segment when it shows", async () => {
  const strip = renderStrip(boardB(), [{ key: "bb--git/changed-files", pluginId: "bb--git" }]);
  expect((await strip.summary.findByTestId("sc-strip")).textContent).toBe(
    "Draft #4822 checks running",
  );
});

test("Mark ready names the pull request and head the reader saw", async () => {
  const strip = renderStrip(boardB());
  const button = await strip.action.findByTestId("sc-strip-mark-ready");
  act(() => (button as HTMLButtonElement).click());
  await waitFor(() => expect(strip.forgeCalls).toHaveLength(1));
  expect(strip.forgeCalls[0]).toEqual({
    threadId: "thread-a",
    action: { kind: "setDraft", draft: false },
    expected: { number: 482, head: "c0ffee" },
  });
});

test("Ship it on a pushed branch with no pull request asks the thread's agent to ship", async () => {
  const row = boardB();
  if (row.state !== "checkout") throw new Error("fixture");
  row.forge = { read: { value: null, at: Date.now() }, problem: null };
  const strip = renderStrip(row);
  // With no pull request number to name it, the strip names the branch.
  expect((await strip.summary.findByTestId("sc-strip")).textContent).toBe(
    "Pushed, no pull requestscott/forge-host3 uncommitted",
  );
  const button = await strip.action.findByTestId("sc-strip-ship");
  // The action sits at the row's end, after every segment's summary.
  expect(button.closest("[data-bb-plugin]")?.className).toContain("ml-auto");
  expect(strip.action.queryByTestId("sc-strip-mark-ready")).toBeNull();
  act(() => (button as HTMLButtonElement).click());
  await waitFor(() => expect(strip.shipCalls).toEqual([{ threadId: "thread-a" }]));
  expect((await strip.action.findByText("Asked the agent to ship it.")).className).toContain(
    "text-muted-foreground",
  );
});

test("the strip offers no Ship it before GitHub answers or once a pull request exists", async () => {
  const row = boardB();
  if (row.state !== "checkout") throw new Error("fixture");
  row.forge = { read: null, problem: null };
  const unread = renderStrip(row);
  await unread.summary.findByTestId("sc-strip");
  expect(unread.action.queryByTestId("sc-strip-ship")).toBeNull();
  const drafted = renderStrip(boardB());
  await drafted.action.findByTestId("sc-strip-mark-ready");
  expect(drafted.action.queryByTestId("sc-strip-ship")).toBeNull();
});

test("the strip hides for a thread with no Change of its own", async () => {
  const { useStripVisible } = await import("./composer-strip.tsx");
  const visible: boolean[] = [];
  function Probe({ row }: { row: ThreadChange }) {
    visible.push(
      useStripVisible({ threadId: "thread-a", projectId: "proj", environment: { id: "env" } }),
    );
    void row;
    return null;
  }
  const none: ThreadChange = { state: "none", reason: "This thread has no project environment." };
  renderSlot(
    { component: Probe },
    { row: none },
    {
      experimental_rpcContract: sourceControlContract,
      rpc: { changeForThread: () => ({ "thread-a": none }) } as Rpc,
    },
  );
  await waitFor(() => expect(visible.length).toBeGreaterThan(1));
  expect(visible.at(-1)).toBe(false);
  expect(segment.useVisible).toBe(useStripVisible);
});

test("the chat card's chip and the composer strip say the same thing from one summary", async () => {
  const { changeState, summarize } = await import("../core/status.ts");
  const { ChangeDirective } = await import("./chat-card.tsx");
  const pushedNoPr = checkout("scott/pushed", null);
  if (pushedNoPr.state !== "checkout" || !pushedNoPr.local.read) throw new Error("fixture");
  pushedNoPr.local.read.value = local("scott/pushed", {
    stacks: [
      {
        key: "scott/pushed",
        branches: [branchOf("scott/pushed", { status: "pushed", push: "none", ahead: 0 })],
        assigned: [],
      },
    ],
  });
  // One commit ahead of its remote: the strip used to say "Pushed" here.
  const ahead = checkout("scott/ahead", null);
  if (ahead.state !== "checkout" || !ahead.local.read) throw new Error("fixture");
  ahead.local.read.value = local("scott/ahead", {
    stacks: [
      {
        key: "scott/ahead",
        branches: [branchOf("scott/ahead", { status: "ahead", push: "push", ahead: 2 })],
        assigned: [],
      },
    ],
  });
  const cases: [ThreadChange, string, string][] = [
    [pushedNoPr, "Pushed", "Pushed, no pull request"],
    [ahead, "Unpushed", "Unpushed"],
    [boardB(), "Draft", "Draft #482"],
  ];
  for (const [row, chip, lead] of cases) {
    if (row.state !== "checkout") throw new Error("fixture");
    const summary = summarize(row)!;
    const strip = renderStrip(row);
    expect((await strip.summary.findByTestId("sc-strip")).firstChild?.textContent).toBe(lead);
    const detail = {
      state: "change" as const,
      row: {
        key: row.key!,
        repo: "smsunarto/bb-plugins",
        title: "A change",
        branch: row.branch!,
        baseRef: "main",
        number: summary.pullRequest?.number ?? null,
        url: null,
        author: null,
        mine: true,
        asked: false,
        state: summary.pullRequest ? ("draft" as const) : ("local" as const),
        stack: null,
        hostId: "host-a",
        line: "",
        chips: [],
        sort: 0,
        updatedAt: null,
      },
      head: "c0ffee",
      files: null,
      additions: null,
      deletions: null,
      revision: null,
      stack: null,
      canMarkReady: false,
      ship: [],
      status: changeState(summary),
      problem: null,
      at: Date.now(),
    };
    const card = renderSlot(
      { component: ChangeDirective },
      {
        attributes: { key: encodeURIComponent(row.key!), revision: "c0ffee" },
        source: "",
        message: { id: "m1", threadId: "thread-a", turnId: null, projectId: null },
        openWorkspaceFile: null,
      },
      {
        experimental_rpcContract: sourceControlContract,
        pluginId: "source-control",
        rpc: {
          changeDetail: ({ keys }: { keys: string[] }) =>
            Object.fromEntries(keys.map((key) => [key, detail])),
          checksForChange: ({ keys }: { keys: string[] }) =>
            Object.fromEntries(keys.map((key) => [key, { read: null, problem: null }])),
          reviewForChange: () => ({}),
        } as never,
      },
    );
    const header = await card.findByTestId("sc-card");
    expect(header.textContent!.startsWith(chip)).toBe(true);
    cleanup();
  }
});

function renderInfo(kind: "row" | "section", row: ThreadChange) {
  const registration =
    kind === "row"
      ? app.threadInfoRows.find((each) => each.id === "pull-request")!
      : app.threadInfoSections.find((each) => each.id === "branches")!;
  return renderSlot(
    registration as never,
    { threadId: "thread-a", projectId: "proj", environment: { id: "env" } } as never,
    {
      experimental_rpcContract: sourceControlContract,
      rpc: { changeForThread: () => ({ "thread-a": row }) } as Rpc,
    },
  );
}

/** `stacked()` read as plain git: bb's own Branch and Pull request rows speak for it. */
function plainGit(): ThreadChange {
  const row = stacked();
  if (row.state !== "checkout" || !row.local.read) throw new Error("fixture");
  row.local.read.value = { ...row.local.read.value, provider: "git" };
  return row;
}

test("the Info tab's Pull request row shows a GitButler thread's pull request, and nothing for plain git", async () => {
  const slot = renderInfo("row", stacked());
  const link = await slot.findByRole("link", { name: /Pull request 482: Draft/ });
  expect(link.textContent).toContain("#482");
  cleanup();
  const plain = renderInfo("row", plainGit());
  await new Promise((settle) => setTimeout(settle, 30));
  expect(plain.queryByRole("link")).toBeNull();
});

test("the Info tab lists a GitButler workspace's branches, top first, and nothing for plain git", async () => {
  const slot = renderInfo("section", stacked());
  expect(await slot.findByText("scott/forge-host")).toBeTruthy();
  expect(slot.getByText("scott/core-schema")).toBeTruthy();
  expect(slot.getByText("on scott/core-schema")).toBeTruthy();
  cleanup();
  const plain = renderInfo("section", plainGit());
  await new Promise((settle) => setTimeout(settle, 30));
  expect(plain.queryByText("scott/forge-host")).toBeNull();
});

/** The header action bb would draw for each thread, after `useData` has read `rows`. */
async function headerItems(rows: Record<string, ThreadChange>) {
  const { headerActionItem, useHeaderActionData } = await import("./thread-info.tsx");
  const ids = Object.keys(rows);
  const shown: { current: ReturnType<typeof useHeaderActionData> | null } = { current: null };
  function Probe() {
    const data = useHeaderActionData({ threadIds: ids });
    useLayoutEffect(() => {
      shown.current = data;
    });
    return null;
  }
  const opened: unknown[] = [];
  const slot = renderSlot({ component: Probe }, {} as never, {
    experimental_rpcContract: sourceControlContract,
    rpc: {
      changeForThread: ({ keys }: { keys: string[] }) =>
        Object.fromEntries(keys.map((key) => [key, rows[key]])),
    } as Rpc,
  });
  await waitFor(() => expect(Object.keys(shown.current ?? {})).toHaveLength(ids.length));
  slot.unmount();
  const item = (id: string) =>
    headerActionItem({
      thread: { id },
      data: shown.current,
      experimental_panel: { toggleTab: (options: unknown) => opened.push(options) },
    } as never);
  return { item, opened };
}

test("the header button shows only for a thread with a checkout, says where its Change stands, and toggles the tab", async () => {
  const { SOURCE_CONTROL_TAB } = await import("./thread-info.tsx");
  const registration = app.threadActions.find((each) => each.id === "open")!;
  expect(registration).toMatchObject({ placement: "header", title: "Source Control" });
  const unread = checkout("scott/unread", null);
  if (unread.state !== "checkout") throw new Error("fixture");
  unread.local = { read: null, problem: null };
  const { item, opened } = await headerItems({
    "thread-draft": stacked(),
    "thread-local": checkout("scott/local", null),
    "thread-unread": unread,
    "thread-none": { state: "none", reason: "No checkout" },
  });
  expect(item("thread-none")).toBeNull();
  // A pull request: its number, then what it waits on. The menu row keeps the verb.
  expect(item("thread-draft")).toMatchObject({
    label: "#482 · Draft",
    detail: "View in Source Control",
  });
  expect(item("thread-local")?.label).toBe("Local, not pushed");
  // Nothing read to describe: the button says only what it does.
  expect(item("thread-unread")).toMatchObject({ label: "View in Source Control" });
  expect(item("thread-unread")?.detail).toBeUndefined();
  item("thread-draft")!.run({ requestRename: () => {} });
  expect(opened).toEqual([{ tab: SOURCE_CONTROL_TAB }]);
});

test("a header switched to a thread it has shown keeps its action before bb publishes the id", async () => {
  const { headerActionItem, useHeaderActionData } = await import("./thread-info.tsx");
  const reads: string[][] = [];
  const shown: { current: ReturnType<typeof useHeaderActionData> | null } = { current: null };
  function Probe({ ids }: { ids: string[] }) {
    const data = useHeaderActionData({ threadIds: ids });
    useLayoutEffect(() => {
      shown.current = data;
    });
    return null;
  }
  const rows: Record<string, ThreadChange> = {
    "thread-shown": stacked(),
    "thread-plain": { state: "none", reason: "No checkout" },
  };
  const slot = renderSlot(
    { component: Probe },
    { ids: ["thread-shown", "thread-plain"] } as never,
    {
      experimental_rpcContract: sourceControlContract,
      rpc: {
        changeForThread: ({ keys }: { keys: string[] }) => {
          reads.push(keys);
          return Object.fromEntries(keys.map((key) => [key, rows[key]]));
        },
      } as Rpc,
    },
  );
  await waitFor(() => expect(shown.current?.["thread-shown"]).toBeTruthy());
  slot.unmount();
  // The header now shows another thread; bb has not published its id yet, so data lacks it.
  const input = (id: string) => ({ thread: { id }, data: {}, experimental_panel: {} }) as never;
  expect(headerActionItem(input("thread-shown"))?.label).toBe("#482 · Draft");
  expect(headerActionItem(input("thread-plain"))).toBeNull();
  expect(headerActionItem(input("thread-never-shown"))).toBeNull();
  // Fresh data still wins over the last answer.
  expect(
    headerActionItem({
      thread: { id: "thread-shown" },
      data: { "thread-shown": null },
      experimental_panel: {},
    } as never),
  ).toBeNull();
  expect(reads.flat().toSorted()).toEqual(["thread-plain", "thread-shown"]);
});

test("GitButler's operation history reads only once opened, and lists each operation", async () => {
  const { slot, of } = renderRow(stacked());
  const card = await slot.findByTestId("sc-history");
  await new Promise((settle) => setTimeout(settle, 30));
  expect(of("oplog")).toHaveLength(0);
  await act(async () => slot.getByRole("button", { name: "Operation history" }).click());
  expect((await slot.findByTestId("sc-oplog-row")).textContent).toContain("Create commit");
  expect(of("oplog")[0]!.input).toEqual({ threadId: "thread-a" });
  expect(card.textContent).toContain("22c2d57");
  expect(slot.getByRole("button", { name: "Copy snapshot id 22c2d57" })).toBeTruthy();
});

test("a plain git checkout has no operation history", async () => {
  const { slot } = renderRow(plainGit());
  await slot.findByRole("button", { name: "Push scott/forge-host" });
  expect(slot.queryByTestId("sc-history")).toBeNull();
});

const WATCH = {
  ref: { owner: "smsunarto", repo: "bb-plugins", number: 482 },
  account: "smsunarto",
  url: "https://github.com/smsunarto/bb-plugins/pull/482",
  title: "Route gh through the checkout host",
  state: "open" as const,
  mergeState: "BEHIND",
  checks: {
    headRefOid: "c0ffee1",
    checks: [
      { id: "run:1", name: "lint", state: "failure" as const, detailsUrl: null },
      { id: "run:2", name: "test", state: "success" as const, detailsUrl: null },
    ],
  },
  polledAt: iso(1),
  error: null,
  ended: false,
};

function renderBanner(watches: unknown[], stops: unknown[]) {
  const banner = app.composerCustomizations.find((each) => each.id === "pr-watch")!.banners![0]!;
  return renderSlot(banner as never, {} as never, {
    experimental_rpcContract: sourceControlContract,
    composer: { scope: { kind: "thread", threadId: "thread-a" } as never },
    rpc: {
      prWatches: ({ keys }: { keys: string[] }) =>
        Object.fromEntries(keys.map((key) => [key, { watches }])),
      stopPrWatch: (input: unknown) => {
        stops.push(input);
        return { stopped: true };
      },
    } as Rpc,
  });
}

test("the composer banner shows each watched pull request's checks, and Unwatch stops it", async () => {
  const stops: unknown[] = [];
  const slot = renderBanner([WATCH], stops);
  const row = await slot.findByRole("button", { name: /Show checks$/ });
  expect(row.textContent).toContain("lint failing · Behind base");
  await act(async () => row.click());
  expect(slot.getByRole("list", { name: "2 checks on smsunarto/bb-plugins#482" })).toBeTruthy();
  await act(async () =>
    slot.getByRole("button", { name: "Unwatch smsunarto/bb-plugins#482" }).click(),
  );
  await waitFor(() => expect(stops).toEqual([{ threadId: "thread-a", ref: WATCH.ref }]));
});

test("a thread that watches nothing draws no banner", async () => {
  const slot = renderBanner([], []);
  await new Promise((settle) => setTimeout(settle, 30));
  expect(slot.queryByTestId("sc-pr-watch")).toBeNull();
});

test("with the host offline, every host-bound control is off and says why", async () => {
  const kinds = (root: ParentNode) =>
    [...root.querySelectorAll("[data-host-bound]")]
      .map((node) => node.getAttribute("data-host-bound"))
      .toSorted();
  const online = renderRow(stacked());
  await online.slot.findAllByTestId("sc-branch");
  const drawn = kinds(document);
  // Every host-bound control but Create PR, which the fixture's branches do not offer.
  expect(new Set(drawn)).toEqual(new Set(["pull", "commit", "push", "land", "rename", "delete"]));
  cleanup();
  const row = stacked();
  if (row.state !== "checkout") throw new Error("fixture");
  row.local.problem = { kind: "host-offline", host: row.placement.hostName };
  const { slot, of } = renderRow(row);
  await slot.findAllByTestId("sc-branch");
  expect(kinds(document)).toEqual(drawn);
  for (const control of document.querySelectorAll<HTMLButtonElement>("[data-host-bound]"))
    expect(control.disabled).toBe(true);
  expect(slot.getAllByText(offlineReason(row.placement.hostName)).length).toBeGreaterThan(0);
  expect(of("vcsAction")).toHaveLength(0);
  // Create PR, on a branch GitHub has no pull request for.
  cleanup();
  row.forge = { read: { value: null, at: Date.now() }, problem: null };
  renderRow(row);
  const create = await waitFor(() => {
    const node = document.querySelector<HTMLButtonElement>("[data-host-bound=createPullRequest]");
    if (!node) throw new Error("no Create PR");
    return node;
  });
  expect(create.disabled).toBe(true);
  expect(create.parentElement!.title).toBe(offlineReason(row.placement.hostName));
});
