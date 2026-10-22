import "./dom.ts";
import { beforeEach, expect, test } from "bun:test";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { AGENT_ACTIVITY_CHANNEL, branchReviewRange } from "../src/shared/schema.ts";
import { rpc } from "../src/app/rpc.ts";
import type { AgentActivity, LinkedThread } from "../src/shared/schema.ts";
import { agentActivity, inbox, localBranch, localBranches, localChanges } from "./app-fixtures.ts";

const { act, fireEvent, waitFor, within } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { REVEAL_EVENT } = await import("../src/app/finding.tsx");

function diffBody(card: HTMLElement): HTMLElement {
  const id = within(card).getByRole("checkbox").getAttribute("aria-controls")!;
  return document.getElementById(id)!;
}

beforeEach(() => {
  pluginQueryClient.clear();
  window.localStorage.clear();
});

type Handlers = Record<string, (input: never) => unknown>;

const baseRpc: Handlers = {
  status: () => ({ ok: true, login: "scott", accounts: ["scott"] }),
  inbox: () => inbox,
  localBranches: () => localBranches,
  localBranch: (input: { id: string }) => {
    if (input.id !== localBranch.id)
      throw new Error("This branch is no longer unpublished, or its machine is offline.");
    return localBranch;
  },
  localChanges: () => localChanges,
  branchActivity: () => agentActivity,
  branchReviewed: () => ({ paths: [] }),
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
  expect(await slot.findByRole("article", { name: "src/limit.ts" })).toBeTruthy();
  expect(slot.queryByRole("tablist", { name: "View" })).toBeNull();
  slot.lifecycle.unmount();
});

test("a new local commit preserves the mounted overview and scroll area", async () => {
  const slot = await page(`${BRANCH}/changes`, {
    ...baseRpc,
    localChanges: (input: { head: string }) => ({ ...localChanges, headRefOid: input.head }),
  });
  await slot.findByRole("article", { name: "src/limit.ts" });
  const area = slot.container.querySelector<HTMLElement>("[data-cr-scroll]")!;
  const overview = slot.getByRole("region", { name: "Commits" });
  fireEvent.wheel(area);
  area.scrollTop = 400;
  await act(async () => {
    pluginQueryClient.setQueryData(rpc.localBranch.queryKey({ id: localBranch.id }), {
      ...localBranch,
      head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  });
  await slot.findByRole("article", { name: "src/limit.ts" });
  expect(slot.container.querySelector("[data-cr-scroll]")).toBe(area);
  expect(slot.getByRole("region", { name: "Commits" })).toBe(overview);
  expect(area.scrollTop).toBe(400);
  slot.lifecycle.unmount();
});

test("a branch's Changes show its diff and allow reviewing each file", async () => {
  const slot = await page(`${BRANCH}/changes`);
  const card = await slot.findByRole("article", { name: "src/limit.ts" });
  expect(slot.rpcCalls.find((call) => call.method === "localChanges")?.input).toEqual({
    hostId: "host-1",
    path: "/home/scott/git/api",
    base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    head: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
  });
  expect(await slot.findByText("0 of 1 file reviewed")).toBeTruthy();
  expect(within(card).getByRole("checkbox", { name: "Reviewed src/limit.ts" })).toBeTruthy();
  expect(within(card).queryByRole("link", { name: /on GitHub/ })).toBeNull();
  expect(diffBody(card).hidden).toBe(false);
  slot.lifecycle.unmount();
});

test("local review progress survives remounts, is reversible, and reaches Ready", async () => {
  let paths: string[] = [];
  const handlers: Handlers = {
    ...baseRpc,
    branchReviewed: () => ({ paths }),
    setBranchViewed: (input: { path: string; viewed: boolean }) => {
      paths = input.viewed ? [input.path] : [];
      return { viewed: input.viewed ? "viewed" : "unviewed" };
    },
  };
  const first = await page(`${BRANCH}/changes`, handlers);
  fireEvent.click(
    within(await first.findByRole("article", { name: "src/limit.ts" })).getByRole("checkbox", {
      name: "Reviewed src/limit.ts",
    }),
  );
  await first.findByText("Ready");
  await waitFor(() => expect(paths).toEqual(["src/limit.ts"]));
  expect(first.rpcCalls.find((call) => call.method === "setBranchViewed")?.input).toEqual({
    id: localBranch.id,
    base: localBranch.base,
    head: localBranch.head,
    path: "src/limit.ts",
    viewed: true,
  });
  first.lifecycle.unmount();
  pluginQueryClient.clear();
  const second = await page(`${BRANCH}/changes`, handlers);
  const checked = within(await second.findByRole("article", { name: "src/limit.ts" })).getByRole(
    "checkbox",
    { name: "Reviewed src/limit.ts" },
  );
  await second.findByText("Ready");
  expect((checked as HTMLInputElement).checked).toBe(true);
  fireEvent.click(checked);
  await second.findByText("0 of 1 file reviewed");
  await waitFor(() => expect(paths).toEqual([]));
  second.lifecycle.unmount();
});

test("failed local review saves restore the checkbox and explain the failure", async () => {
  const slot = await page(`${BRANCH}/changes`, {
    ...baseRpc,
    setBranchViewed: () => {
      throw new Error("Storage is unavailable");
    },
  });
  const checkbox = within(await slot.findByRole("article", { name: "src/limit.ts" })).getByRole(
    "checkbox",
    { name: "Reviewed src/limit.ts" },
  );
  fireEvent.click(checkbox);
  await slot.findByText(/Could not mark src\/limit.ts as reviewed/);
  expect((checkbox as HTMLInputElement).checked).toBe(false);
  expect(slot.queryByText("Ready")).toBeNull();
  slot.lifecycle.unmount();
});

test("a cold branch waits for review marks before mounting its reviewed diffs", async () => {
  let finish: ((value: { paths: string[] }) => void) | undefined;
  const marks = new Promise<{ paths: string[] }>((resolve) => {
    finish = resolve;
  });
  const slot = await page(`${BRANCH}/changes`, { ...baseRpc, branchReviewed: () => marks });
  try {
    await slot.findByText("Loading review progress…");
    expect(slot.queryByRole("article", { name: "src/limit.ts" })).toBeNull();
    expect(slot.rpcCalls.some((call) => call.method === "localChanges")).toBe(true);
    finish?.({ paths: ["src/limit.ts"] });
    const card = await slot.findByRole("article", { name: "src/limit.ts" });
    expect(diffBody(card).hidden).toBe(true);
    await slot.findByText("Ready");
  } finally {
    finish?.({ paths: [] });
    slot.lifecycle.unmount();
  }
});

test("cached local checkboxes remain usable after a background read fails", async () => {
  let failing = false;
  let saved = false;
  const slot = await page(`${BRANCH}/changes`, {
    ...baseRpc,
    branchReviewed: () => {
      if (failing) throw new Error("Read unavailable");
      return { paths: [] };
    },
    setBranchViewed: () => {
      saved = true;
      return { viewed: "viewed" };
    },
  });
  try {
    const card = await slot.findByRole("article", { name: "src/limit.ts" });
    failing = true;
    await pluginQueryClient.invalidateQueries({
      queryKey: rpc.branchReviewed.queryKey(branchReviewRange(localBranch)),
    });
    await slot.findByText("Review progress could not load");
    fireEvent.click(within(card).getByRole("checkbox", { name: "Reviewed src/limit.ts" }));
    await waitFor(() => expect(saved).toBe(true));
  } finally {
    slot.lifecycle.unmount();
  }
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
    await slot.findByText("This branch is no longer unpublished, or its machine is offline."),
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
