// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Branch, ThreadChange, WorkspaceValue } from "../core/change.ts";
import { changeKeySchema } from "../core/ids.ts";
import type { ChangeDetail } from "../core/review.ts";
import { canShip, changeState, summarize } from "../core/status.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { ChangeDirective } from "./chat-card.tsx";

afterEach(cleanup);

const BRANCH = "scott/forge-host";
const KEY = changeKeySchema.parse(`gh:smsunarto/bb-plugins:smsunarto:${BRANCH}`);
type Checkout = Extract<ThreadChange, { state: "checkout" }>;

function branch(overrides: Partial<Branch> = {}): Branch {
  return {
    name: BRANCH,
    head: "c0ffee1",
    remote: null,
    status: "unpushed",
    push: "push",
    ahead: 1,
    behind: 0,
    newUpstream: 0,
    reviewId: null,
    commits: [
      { id: "c0ffee1", subject: "Move gh to the host", createdAt: null, conflicted: false },
    ],
    moreCommits: 0,
    upstreamCommits: [],
    ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceValue> = {}): WorkspaceValue {
  return {
    provider: "gitbutler",
    path: "/work/bb-plugins",
    commonDir: "/work/bb-plugins/.git",
    checkedOut: null,
    github: { repo: { owner: "smsunarto", name: "bb-plugins" }, headOwner: "smsunarto" },
    uncommitted: [],
    moreUncommitted: 0,
    conflicted: [],
    stacks: [{ key: BRANCH, branches: [branch()], assigned: [] }],
    target: { ref: "origin/main", head: "a41c9e2", behind: 0, base: null, lastFetched: null },
    ...overrides,
  };
}

/** A thread's row: on its branch, or with no branch of its own when `own` is false. */
function row(value: WorkspaceValue, own = true, pullRequest: unknown = null): Checkout {
  return {
    state: "checkout",
    placement: {
      hostId: "host-a",
      hostName: "studio-mac",
      path: "/work/bb-plugins",
      environmentId: "env",
    },
    readAsGit: false,
    branch: own ? BRANCH : null,
    key: own ? KEY : null,
    local: { read: { value, at: Date.now() }, problem: null },
    forge: { read: { value: pullRequest as never, at: Date.now() }, problem: null },
  };
}

const files = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/${index}.ts`,
    kind: "modified" as const,
  }));

function detailOf(thread: Checkout): ChangeDetail {
  return {
    state: "change",
    row: {
      key: KEY,
      repo: "smsunarto/bb-plugins",
      title: "Move gh to the host",
      branch: BRANCH,
      baseRef: "main",
      number: null,
      url: null,
      author: null,
      mine: true,
      asked: false,
      state: "local",
      stack: null,
      hostId: "host-a",
      line: "",
      chips: [],
      sort: 0,
      updatedAt: null,
    },
    head: "c0ffee1",
    files: null,
    additions: null,
    deletions: null,
    revision: null,
    stack: null,
    canMarkReady: false,
    ship: [],
    status: changeState(summarize(thread)!),
    problem: null,
    at: Date.now(),
  } as ChangeDetail;
}

/** `::source-control` alone in a reply of `thread-a`, whose row is `thread`. */
function renderThread(thread: ThreadChange, attributes: Record<string, string> = {}) {
  const shipped: unknown[] = [];
  const slot = renderSlot(
    { component: ChangeDirective },
    {
      attributes,
      source: "::source-control",
      message: { id: "m1", threadId: "thread-a", turnId: null, projectId: null },
      openWorkspaceFile: null,
    },
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      rpc: {
        changeForThread: () => ({ "thread-a": thread }),
        changeDetail: ({ keys }: { keys: string[] }) =>
          Object.fromEntries(
            keys.map((key) => [key, thread.state === "checkout" ? detailOf(thread) : null]),
          ),
        checksForChange: ({ keys }: { keys: string[] }) =>
          Object.fromEntries(keys.map((key) => [key, { read: null, problem: null }])),
        reviewForChange: () => ({}),
        legacyChange: ({ keys }: { keys: string[] }) =>
          Object.fromEntries(
            keys.map((key) => [
              key,
              key === "pr:smsunarto/bb-plugins#482"
                ? { key: KEY, problem: null }
                : { key: null, problem: "GitHub has no such pull request." },
            ]),
          ),
        shipThread: (input: unknown) => {
          shipped.push(input);
          return { ok: true };
        },
      } as never,
    },
  );
  return { slot, shipped };
}

test("a hand-written directive shows the thread's own Change, its uncommitted files, and ships it", async () => {
  const { slot, shipped } = renderThread(row(workspace({ uncommitted: files(3) })));
  const card = await slot.findByTestId("sc-card");
  expect(card.getAttribute("data-key")).toBe(KEY);
  expect(slot.getByTestId("sc-card-uncommitted-count").textContent).toBe(
    "3 uncommitted files in this checkout",
  );
  slot.getByTestId("sc-card-ship").click();
  await waitFor(() => expect(shipped).toEqual([{ threadId: "thread-a" }]));
  expect(await slot.findByText("Asked the agent to ship it.")).toBeTruthy();
});

test("uncommitted work with no branch of the thread's own still gets a card that ships it", async () => {
  const { slot, shipped } = renderThread(row(workspace({ uncommitted: files(1) }), false));
  const card = await slot.findByTestId("sc-card-uncommitted");
  expect(card.textContent).toContain("1 uncommitted file in this checkout");
  expect(slot.queryByTestId("sc-card")).toBeNull();
  slot.getByTestId("sc-card-ship").click();
  await waitFor(() => expect(shipped).toHaveLength(1));
});

test("a checked-out branch with no commits of its own, such as main, shows only the files to ship", async () => {
  const main = branch({ name: BRANCH, commits: [], status: "pushed", push: "none", ahead: 0 });
  const thread = row(
    workspace({
      provider: "git",
      checkedOut: BRANCH,
      uncommitted: files(2),
      stacks: [{ key: BRANCH, branches: [main], assigned: [] }],
    }),
  );
  const { slot } = renderThread(thread);
  expect((await slot.findByTestId("sc-card-uncommitted")).textContent).toContain(
    "2 uncommitted files in this checkout",
  );
  expect(slot.queryByTestId("sc-card")).toBeNull();
});

test("work already pushed with an open pull request offers no Ship it", async () => {
  const pushed = branch({
    remote: { ref: `origin/${BRANCH}`, name: BRANCH },
    status: "pushed",
    push: "none",
    ahead: 0,
  });
  const open = {
    number: 482,
    url: "https://github.com/smsunarto/bb-plugins/pull/482",
    title: "Move gh to the host",
    state: "open",
    isDraft: false,
    headRefOid: "c0ffee1",
    baseRef: "main",
    reviewDecision: null,
    mergeable: "mergeable",
    approvals: 0,
    additions: 4,
    deletions: 1,
    changedFiles: 1,
    commits: 1,
    checks: { passed: 1, failed: 0, pending: 0 },
  };
  const thread = row(
    workspace({ stacks: [{ key: BRANCH, branches: [pushed], assigned: [] }] }),
    true,
    open,
  );
  expect(canShip(summarize(thread)!)).toBe(false);
  const { slot } = renderThread(thread);
  await slot.findByTestId("sc-card");
  expect(slot.queryByTestId("sc-card-ship")).toBeNull();
  expect(slot.queryByTestId("sc-card-uncommitted-count")).toBeNull();
});

test("a directive written where nothing changed is one quiet line, not a card", async () => {
  const clean = renderThread(row(workspace(), false));
  expect((await clean.slot.findByTestId("sc-card-clean")).textContent).toContain(
    "Nothing left to ship",
  );
  expect(clean.slot.queryByTestId("sc-card-ship")).toBeNull();
  cleanup();
  const none = renderThread({ state: "none", reason: "No environment." });
  expect(await none.slot.findByTestId("sc-card-none")).toBeTruthy();
});

test("a pushed branch with no pull request, or commits the remote lacks, can still ship", () => {
  const remote = { ref: `origin/${BRANCH}`, name: BRANCH };
  const of = (overrides: Partial<Branch>) =>
    canShip(
      summarize(
        row(workspace({ stacks: [{ key: BRANCH, branches: [branch(overrides)], assigned: [] }] })),
      )!,
    );
  expect(of({ remote, status: "pushed", push: "none", ahead: 0 })).toBe(true);
  expect(of({ remote, status: "ahead" })).toBe(true);
  expect(of({ commits: [], status: "unpushed" })).toBe(false);
});

test("a hand-written pull request, by reference or URL, shows that Change wherever it lives", async () => {
  const thread = row(workspace());
  for (const pr of [
    "smsunarto/bb-plugins#482",
    "https://github.com/smsunarto/bb-plugins/pull/482",
  ]) {
    const { slot } = renderThread(thread, { pr });
    expect((await slot.findByTestId("sc-card")).getAttribute("data-key")).toBe(KEY);
    // Another checkout's work: this thread's uncommitted files and Ship it are not its.
    expect(slot.queryByTestId("sc-card-ship")).toBeNull();
    cleanup();
  }
  const missing = renderThread(thread, { pr: "smsunarto/bb-plugins#9" });
  expect(await missing.slot.findByText(/GitHub has no such pull request/)).toBeTruthy();
  cleanup();
  const invalid = renderThread(thread, { pr: "the docs PR" });
  expect(invalid.slot.getByTestId("sc-card-invalid").textContent).toContain("owner/repo#123");
});

test("the share tool's keyed card ships the thread's own Change, and not another thread's", async () => {
  const thread = row(workspace({ uncommitted: files(2) }));
  const own = renderThread(thread, { key: encodeURIComponent(KEY), revision: "c0ffee1" });
  expect((await own.slot.findByTestId("sc-card")).getAttribute("data-key")).toBe(KEY);
  expect(await own.slot.findByTestId("sc-card-uncommitted-count")).toBeTruthy();
  (await own.slot.findByTestId("sc-card-ship")).click();
  await waitFor(() => expect(own.shipped).toEqual([{ threadId: "thread-a" }]));
  cleanup();
  // A Change this thread shares but whose branch is not its own: nothing of this checkout's to ship.
  const other = renderThread(row(workspace({ uncommitted: files(2) }), false), {
    key: encodeURIComponent(KEY),
    revision: "c0ffee1",
  });
  await other.slot.findByTestId("sc-card");
  expect(other.slot.queryByTestId("sc-card-ship")).toBeNull();
});
