import "./dom.ts";
import { beforeEach, expect, test } from "bun:test";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { AGENT_ACTIVITY_CHANNEL } from "../src/shared/schema.ts";
import type { AgentActivity, LinkedThread } from "../src/shared/schema.ts";
import { agentActivity, inbox, localBranch, localBranches, localChanges } from "./app-fixtures.ts";

const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { REVEAL_EVENT } = await import("../src/app/finding.tsx");

beforeEach(() => {
  pluginQueryClient.clear();
  window.localStorage.clear();
});

type Handlers = Record<string, (input: never) => unknown>;

const baseRpc: Handlers = {
  status: () => ({ ok: true, login: "scott", accounts: ["scott"] }),
  inbox: () => inbox,
  localBranches: () => localBranches,
  localChanges: () => localChanges,
  branchActivity: () => agentActivity,
  reviewInstructions: () => ({ instructions: "" }),
};

async function registration() {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  return app.navPanels[0]!;
}

async function page(subPath: string, rpc: Handlers = baseRpc) {
  return renderSlot(await registration(), { subPath }, { rpc: rpc as never });
}

async function inboxTab(subPath: string, rpc: Handlers = baseRpc) {
  return renderSlot((await registration()).fixedTabs![0]!, { subPath }, { rpc: rpc as never });
}

/** Radix tabs select on mouse down, not click. */
function selectTab(tab: HTMLElement) {
  fireEvent.mouseDown(tab, { button: 0 });
}

const BRANCH = `branch/${localBranch.id}`;

const reviewed: AgentActivity = {
  threads: [],
  latestReview: {
    threadId: "thread-done",
    headRefOid: localBranch.head,
    baseRefName: localBranch.base,
    reportedAt: "2026-01-02T10:00:00Z",
    summary: "One problem.",
    findings: [
      {
        id: "F1",
        priority: 1,
        title: "The bucket never refills",
        body: "Nothing adds tokens back.",
        path: "src/limit.ts",
        line: 2,
        startLine: null,
        side: "RIGHT",
      },
    ],
  },
};

test("unpublished branches get an inbox tab with a count, and a row opens its branch", async () => {
  const slot = await inboxTab("");
  const tab = await slot.findByRole("tab", { name: /Unpublished/ });
  expect(slot.getAllByRole("tab").map((each) => each.textContent)).toEqual([
    "Assigned to me2",
    "My team1",
    "Authored by me1",
    "Unpublished2",
  ]);

  selectTab(tab);
  const row = await slot.findByRole("button", { name: /scott\/rate-limit/ });
  expect(within(row).getByText("api")).toBeTruthy();
  expect(within(row).getByText("cardinal")).toBeTruthy();
  expect(within(row).getByText("2 commits")).toBeTruthy();
  expect(within(row).getByText("Ahead")).toBeTruthy();
  expect(row.textContent).toContain("on scott/login-copy");
  // The bottom of the stack is on nothing.
  const bottom = slot.getByRole("button", { name: /scott\/login-copy.*1 commit/ });
  expect(bottom.textContent).not.toContain("on ");

  fireEvent.click(row);
  expect(slot.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "code-review", options: { subPath: "branch/a1b2c3d4e5f6" } },
  ]);
  slot.lifecycle.unmount();
});

test("without the GitButler plugin there is no Unpublished tab, even for a reader who left it open", async () => {
  window.localStorage.setItem("bb-plugin-code-review:inbox-section", "unpublished");
  const slot = await inboxTab("", {
    ...baseRpc,
    localBranches: () => ({ available: false, reason: "Install and enable the GitButler plugin." }),
  });
  // The pull requests show once GitButler has answered that it is not there.
  await slot.findByText("Rate-limit the login endpoint");
  expect(slot.getAllByRole("tab").map((each) => each.textContent)).toEqual([
    "Assigned to me2",
    "My team1",
    "Authored by me1",
  ]);
  slot.lifecycle.unmount();
});

test("a branch's page names it, and its summary lists its commits", async () => {
  const slot = await page(BRANCH);
  expect((await slot.findByRole("heading", { level: 1 })).textContent).toBe("scott/rate-limit");
  expect(slot.getByText("api")).toBeTruthy();
  expect(slot.getByText("cardinal")).toBeTruthy();
  expect(slot.getByText("2 commits")).toBeTruthy();
  expect(slot.getByText("scott/login-copy")).toBeTruthy();

  const commits = within(slot.getByRole("region", { name: "Commits" })).getAllByRole("listitem");
  expect(commits.map((commit) => commit.textContent)).toEqual([
    expect.stringContaining("cc36d32Rate-limit the login endpointScott"),
    expect.stringContaining("5d1a8e0Add a bucket typeAda"),
  ]);
  slot.lifecycle.unmount();
});

test("a branch's Changes show its diff from its checkout, with nothing to mark viewed", async () => {
  const slot = await page(`${BRANCH}/changes`);
  const card = await slot.findByRole("article", { name: "src/limit.ts" });
  expect(slot.rpcCalls.find((call) => call.method === "localChanges")?.input).toEqual({
    hostId: "host-1",
    path: "/home/scott/git/api",
    base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    head: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
  });
  expect(slot.getByText("1 file")).toBeTruthy();
  expect(slot.queryByText(/viewed/)).toBeNull();
  expect(slot.queryAllByRole("checkbox")).toEqual([]);
  expect(within(card).queryByRole("link", { name: /on GitHub/ })).toBeNull();
  expect(within(card).getByRole("button", { name: "Collapse src/limit.ts" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("findings show on a branch's summary, with no draft comment to add, and reveal in Changes", async () => {
  const slot = await page(BRANCH, { ...baseRpc, branchActivity: () => reviewed });
  // Status, then the branch list, then its activity: three reads in a row.
  const review = await slot.findByRole("region", { name: "bb review" }, { timeout: 5_000 });
  expect(within(review).getByRole("heading", { name: "The bucket never refills" })).toBeTruthy();
  expect(within(review).queryByRole("button", { name: /draft comment/ })).toBeNull();

  fireEvent.click(within(review).getByRole("button", { name: "Show in Changes" }));
  expect(slot.navigateCalls).toEqual([
    {
      method: "toPluginPanel",
      path: "code-review",
      options: { subPath: "branch/a1b2c3d4e5f6/changes" },
    },
  ]);
  slot.lifecycle.unmount();
});

test("findings sit inline in a branch's diff, and its gutter offers no comment", async () => {
  window.dispatchEvent(
    new window.CustomEvent(REVEAL_EVENT, {
      detail: { path: "src/limit.ts", line: 2, side: "RIGHT" },
    }),
  );
  const slot = await page(`${BRANCH}/changes`, { ...baseRpc, branchActivity: () => reviewed });
  const card = await slot.findByRole("article", { name: "src/limit.ts" });
  expect(await within(card).findByText("bb finding")).toBeTruthy();
  expect(within(card).getByRole("heading", { name: "The bucket never refills" })).toBeTruthy();
  expect(within(card).queryByRole("button", { name: /draft comment/ })).toBeNull();

  // The revealed line is selected, which is where a pull request draws its "+".
  const diff = await waitFor(() => {
    const host = [...card.querySelectorAll("*")].find((element) =>
      element.shadowRoot?.querySelector("[data-selected-line]"),
    );
    if (!host?.shadowRoot) throw new Error("no selected line yet");
    return host.shadowRoot;
  });
  expect(diff.querySelector("[data-utility-button]")).toBeNull();
  slot.lifecycle.unmount();
});

function running(threadId: string): LinkedThread {
  return {
    threadId,
    kind: "review",
    title: null,
    status: "active",
    createdAt: "2026-01-02T11:00:00Z",
    headRefOid: localBranch.head,
    baseRefName: localBranch.base,
  };
}

test("Review with bb on a branch starts one review, then opens it", async () => {
  let activity = agentActivity;
  const slot = await page(BRANCH, {
    ...baseRpc,
    branchActivity: () => activity,
    startLocalReview: () => {
      activity = { threads: [running("thread-branch")], latestReview: null };
      return { threadId: "thread-branch" };
    },
  });

  fireEvent.click(await slot.findByRole("button", { name: "Review with bb" }));
  const reviewing = await slot.findByRole("button", { name: "Reviewing…" });
  expect(slot.rpcCalls.filter((call) => call.method === "startLocalReview")).toEqual([
    { method: "startLocalReview", input: { id: "a1b2c3d4e5f6" } },
  ]);

  fireEvent.click(reviewing);
  expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId: "thread-branch" }]);
  expect(slot.rpcCalls.filter((call) => call.method === "startLocalReview")).toHaveLength(1);
  slot.lifecycle.unmount();
});

test("a branch's activity is read again when the server says it changed", async () => {
  const slot = await page(BRANCH);
  await slot.findByRole("button", { name: "Review with bb" });
  const reads = () => slot.rpcCalls.filter((call) => call.method === "branchActivity").length;
  await waitFor(() => expect(reads()).toBe(1));

  await slot.emitRealtime(AGENT_ACTIVITY_CHANNEL, { key: "branch:0f1e2d3c4b5a" });
  await slot.emitRealtime(AGENT_ACTIVITY_CHANNEL, { key: "branch:a1b2c3d4e5f6" });
  await waitFor(() => expect(reads()).toBe(2));
  slot.lifecycle.unmount();
});

test("a branch no longer listed says so, and leads back to the inbox", async () => {
  const slot = await page("branch/ffffffffffff");
  expect(
    await slot.findByText(
      "This branch has no unpublished commits any more, or its machine is offline.",
    ),
  ).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Back to inbox" }));
  expect(slot.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "code-review", options: { subPath: "" } },
  ]);
  slot.lifecycle.unmount();
});

const signedOut: Handlers = {
  ...baseRpc,
  status: () => ({ ok: false, reason: "unauthenticated", message: "Not signed in." }),
  inbox: () => {
    throw new Error("GitHub CLI is not signed in.");
  },
};

test("a branch opens with gh signed out: it needs no GitHub", async () => {
  const slot = await page(BRANCH, signedOut);
  expect((await slot.findByRole("heading", { level: 1 })).textContent).toBe("scott/rate-limit");
  expect(slot.queryByText("Sign in to GitHub")).toBeNull();
  slot.lifecycle.unmount();
});

test("with gh signed out, the inbox still lists unpublished branches", async () => {
  const slot = await inboxTab("", signedOut);
  const list = await slot.findByRole("region", { name: "Unpublished branches" });
  expect(await within(list).findByRole("button", { name: /scott\/rate-limit/ })).toBeTruthy();
  expect(slot.getByText("GitHub is unavailable. The page says how to fix it.")).toBeTruthy();
  slot.lifecycle.unmount();
});
