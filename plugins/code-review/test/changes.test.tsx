import "./dom.ts";
import { beforeEach, expect, jest, setSystemTime, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../src/app/query.ts";
import type { ChangedFiles, PullRequest, ReviewThread } from "../src/shared/schema.ts";
import { agentActivity, checks, inbox, pullRequest } from "./app-fixtures.ts";

const { act, fireEvent, waitFor, within, configure } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
configure({ asyncUtilTimeout: 5000 });
const { REVEAL_EVENT } = await import("../src/app/finding.tsx");
const { NewCommentForm } = await import("../src/app/comment-form.tsx");
const { queryKey } = await import("../src/app/rpc.ts");

function diffBody(card: HTMLElement): HTMLElement {
  const id = within(card).getByRole("checkbox").getAttribute("aria-controls")!;
  return document.getElementById(id)!;
}

beforeEach(() => {
  queryClient.clear();
  window.localStorage.clear();
});

function thread(overrides: Partial<ReviewThread> & Pick<ReviewThread, "id">): ReviewThread {
  return {
    path: "src/login.ts",
    line: 3,
    startLine: null,
    startSide: null,
    side: "RIGHT",
    originalLine: 3,
    isResolved: false,
    isOutdated: false,
    isFileLevel: false,
    diffHunk: "@@ -1,2 +1,3 @@\n a\n+b",
    comments: [],
    ...overrides,
  };
}

const pr: PullRequest = {
  ...pullRequest,
  threads: [
    thread({
      id: "T1",
      comments: [
        {
          id: "C1",
          author: { login: "ada", avatarUrl: null },
          body: "Why **three**?",
          createdAt: "2026-01-02T10:00:00Z",
          url: "https://github.com/acme/api/pull/42#discussion_r1",
          isDraft: false,
        },
      ],
    }),
    // The viewer's own draft, on a line a later push moved away.
    thread({
      id: "T2",
      line: null,
      isOutdated: true,
      originalLine: 9,
      comments: [
        {
          id: "C2",
          author: { login: "scott", avatarUrl: null },
          body: "old note",
          createdAt: "2026-01-02T10:00:00Z",
          url: "https://github.com/acme/api/pull/42#discussion_r2",
          isDraft: true,
        },
      ],
    }),
  ],
};

const files: ChangedFiles = {
  headRefOid: pr.headRefOid,
  baseRefName: pr.baseRefName,
  comparison: null,
  files: [
    {
      path: "src/login.ts",
      previousPath: null,
      status: "modified",
      additions: 2,
      deletions: 1,
      viewed: "unviewed",
      generated: false,
      patch: "@@ -1,3 +1,4 @@\n import a\n-const b = 1;\n+const b = 2;\n+const c = 3;\n export {};",
    },
    {
      path: "assets/logo.png",
      previousPath: null,
      status: "added",
      additions: 0,
      deletions: 0,
      viewed: "unviewed",
      generated: false,
      patch: null,
    },
    {
      path: "docs/old.md",
      previousPath: null,
      status: "removed",
      additions: 0,
      deletions: 3,
      viewed: "viewed",
      generated: false,
      patch: "@@ -1,3 +0,0 @@\n-a\n-b\n-c",
    },
  ],
};

type Call = { method: string; input: unknown };

/** The page's reads, plus every draft and viewed write, recorded into `calls`. */
function handlers(calls: Call[]) {
  const record =
    <T,>(method: string, result: (input: never) => T) =>
    (input: never) => {
      calls.push({ method, input });
      return result(input);
    };
  return {
    status: () => ({ ok: true, login: "scott", accounts: ["scott"] }),
    inbox: () => inbox,
    pullRequest: () => pr,
    checks: () => checks,
    agentActivity: () => agentActivity,
    reviewInstructions: () => ({ instructions: "" }),
    changedFiles: () => files,
    setViewed: record("setViewed", (input: { viewed: boolean }) => ({
      viewed: input.viewed ? "viewed" : "unviewed",
    })),
    replyDraft: record("replyDraft", () => ({
      commentId: "C9",
      pendingReview: { id: "PRR1", draftCount: 2 },
    })),
    deleteDraft: record("deleteDraft", () => ({ ok: true })),
    addDraftComment: record("addDraftComment", () => ({
      threadId: "TNEW",
      commentId: "CNEW",
      pendingReview: { id: "PRR1", draftCount: 2 },
    })),
  };
}

const CHANGES = "acme/api/pull/42/changes";

/** The Changes tab, with `overrides` standing in for some of the page's handlers. */
async function changesTab(calls: Call[] = [], overrides: Record<string, unknown> = {}) {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const panel = app.navPanels[0]!;
  const rpc = { ...handlers(calls), ...overrides } as never;
  return {
    panel,
    render: () => renderSlot(panel, { subPath: CHANGES }, { rpc }),
  };
}

/** Puts `element` at `top` to `bottom` in the viewport, which jsdom does not lay out. */
function placeAt(element: Element, top: number, bottom: number): void {
  element.getBoundingClientRect = () =>
    ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top }) as DOMRect;
}

test("returning to Summary scrolls the mounted review back to its overview", async () => {
  const { panel, render } = await changesTab();
  const slot = render();
  await slot.findByRole("article", { name: "src/login.ts" });
  const area = slot.container.querySelector<HTMLElement>("[data-cr-scroll]")!;
  const overview = slot.container.querySelector<HTMLElement>('[data-cr-section="summary"]')!;
  placeAt(area, 100, 900);
  overview.getBoundingClientRect = () => ({ top: 112 - area.scrollTop }) as DOMRect;
  area.scrollTop = 500;
  const Page = panel.component;
  slot.lifecycle.rerender(<Page subPath="acme/api/pull/42/summary" />);
  expect(slot.container.querySelector("[data-cr-scroll]")).toBe(area);
  expect(area.scrollTop).toBe(0);
  // A background data refresh does not return the reader to the top.
  area.scrollTop = 300;
  await act(async () => {
    queryClient.setQueryData(queryKey("changedFiles", { account: pr.account, ref: pr.ref }), {
      ...files,
    });
  });
  expect(area.scrollTop).toBe(300);
  slot.lifecycle.unmount();
});

test("a late Changes route cannot override a revealed file", async () => {
  const { panel, render } = await changesTab();
  const slot = render();
  const Page = panel.component;
  await slot.findByRole("article", { name: "src/login.ts" });
  slot.lifecycle.rerender(<Page subPath="acme/api/pull/42/summary" />);
  const area = slot.container.querySelector<HTMLElement>("[data-cr-scroll]")!;
  const card = slot.getByRole("article", { name: "src/login.ts" });
  const heading = slot.container.querySelector('[data-cr-section="changes"]')!;
  placeAt(area, 100, 900);
  card.getBoundingClientRect = () => ({ top: 1700 - area.scrollTop }) as DOMRect;
  heading.getBoundingClientRect = () => ({ top: 1100 - area.scrollTop }) as DOMRect;
  area.scrollTop = 500;
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(REVEAL_EVENT, { detail: { path: "src/login.ts", line: 0, side: "RIGHT" } }),
    );
  });
  await waitFor(() => expect(area.scrollTop).toBe(1592));
  slot.lifecycle.rerender(<Page subPath="acme/api/pull/42/changes" />);
  expect(area.scrollTop).toBe(1592);
  slot.lifecycle.unmount();
});

test("finishing a slow diff load preserves the reader's scroll and reserved file controls", async () => {
  let finish!: (value: ChangedFiles) => void;
  const pending = new Promise<ChangedFiles>((resolve) => {
    finish = resolve;
  });
  const slot = (await changesTab([], { changedFiles: () => pending })).render();
  await slot.findByText("Loading changed files…");
  const area = slot.container.querySelector<HTMLElement>("[data-cr-scroll]")!;
  const rail = slot.getByRole("navigation", { name: "Changed files" });
  const toolbar = slot.getByRole("button", { name: "Split" });
  fireEvent.wheel(area);
  area.scrollTop = 350;
  finish(files);
  await slot.findByRole("article", { name: "src/login.ts" });
  expect(slot.container.querySelector("[data-cr-scroll]")).toBe(area);
  expect(slot.getByRole("navigation", { name: "Changed files" })).toBe(rail);
  expect(slot.getByRole("button", { name: "Split" })).toBe(toolbar);
  expect(area.scrollTop).toBe(350);
  slot.lifecycle.unmount();
});

test("pending and failed files do not describe existing comments as orphaned", async () => {
  let fail!: (error: Error) => void;
  const pending = new Promise<ChangedFiles>((_resolve, reject) => {
    fail = reject;
  });
  const slot = (await changesTab([], { changedFiles: () => pending })).render();
  await slot.findByText("Loading changed files…");
  expect(
    slot.queryByRole("region", { name: "Comments on files no longer in the diff" }),
  ).toBeNull();
  fail(new Error("Files unavailable"));
  await slot.findByText("Changed files failed to load", {}, { timeout: 5000 });
  expect(
    slot.queryByRole("region", { name: "Comments on files no longer in the diff" }),
  ).toBeNull();
  slot.lifecycle.unmount();
});

test("lists every changed file with its threads inline, and folds the viewed one", async () => {
  const slot = (await changesTab()).render();
  await slot.findByText("1 of 3 files viewed");
  await slot.findByRole("article", { name: "Comment by ada" });

  // Each file's card in order, and ada's thread inside the diff of the file it is on.
  expect(
    slot
      .getAllByRole("article")
      .map((card) => card.getAttribute("aria-label"))
      .filter(Boolean),
  ).toEqual(["src/login.ts", "Comment by ada", "assets/logo.png", "docs/old.md"]);
  expect(
    slot.getByText("GitHub sends no diff for this file. It is binary, or too large to show here.", {
      exact: false,
    }),
  ).toBeTruthy();
  expect(diffBody(slot.getByRole("article", { name: "docs/old.md" })).hidden).toBe(true);
  expect(diffBody(slot.getByRole("article", { name: "src/login.ts" })).hidden).toBe(false);
  expect(slot.queryByRole("button", { name: "Collapse src/login.ts" })).toBeNull();
  expect(
    within(slot.getByRole("navigation", { name: "Changed files" })).queryByRole("checkbox"),
  ).toBeNull();
  slot.lifecycle.unmount();
});

test("a failed refresh keeps the files last read on screen and says they are not updated", async () => {
  queryClient.setQueryData(queryKey("changedFiles", { account: pr.account, ref: pr.ref }), files, {
    updatedAt: Date.now() - 60_000,
  });
  const slot = (
    await changesTab([], {
      changedFiles: () => {
        throw new Error("GitHub did not answer");
      },
    })
  ).render();
  expect(await slot.findByText(/^Not updated/, {}, { timeout: 5_000 })).toBeTruthy();
  expect(slot.getByText("1 of 3 files viewed")).toBeTruthy();
  expect(slot.queryByText("Changed files failed to load")).toBeNull();
  slot.lifecycle.unmount();
});

test("a generated file sorts after the rest and starts folded, and opens on request", async () => {
  const lockfile = {
    path: "bun.lock",
    previousPath: null,
    status: "modified" as const,
    additions: 4,
    deletions: 1,
    viewed: "unviewed" as const,
    generated: true,
    patch: "@@ -1,2 +1,5 @@\n {\n-  a\n+  b\n+  c\n+  d\n+  e",
  };
  const slot = (
    await changesTab([], { changedFiles: () => ({ ...files, files: [lockfile, ...files.files] }) })
  ).render();
  await slot.findByText("1 of 4 files viewed");

  expect(
    slot
      .getAllByRole("article")
      .map((card) => card.getAttribute("aria-label"))
      .filter((name) => name && !name.startsWith("Comment")),
  ).toEqual(["src/login.ts", "assets/logo.png", "docs/old.md", "bun.lock"]);
  const card = slot.getByRole("article", { name: "bun.lock" });
  expect(within(card).getByText("Generated")).toBeTruthy();
  expect(within(card).getByText("Generated file, 5 changed lines, folded.")).toBeTruthy();

  fireEvent.click(within(card).getByRole("button", { name: "Show diff" }));
  await waitFor(() => expect(diffBody(card).hidden).toBe(false));
  slot.lifecycle.unmount();
});

test("marking a file viewed tells GitHub and folds its card", async () => {
  const calls: Call[] = [];
  const slot = (await changesTab(calls)).render();
  await slot.findByText("1 of 3 files viewed");

  const card = slot.getByRole("article", { name: "src/login.ts" });
  fireEvent.click(within(card).getByRole("checkbox", { name: "Viewed src/login.ts" }));

  await slot.findByText("2 of 3 files viewed");
  expect(calls).toEqual([
    {
      method: "setViewed",
      input: { account: "scott", pullRequestId: "PR_kwDOA42", path: "src/login.ts", viewed: true },
    },
  ]);
  expect(diffBody(slot.getByRole("article", { name: "src/login.ts" })).hidden).toBe(true);
  slot.lifecycle.unmount();
});

test("quick Viewed clicks reach GitHub one at a time, and it ends at the last click", async () => {
  const calls: Call[] = [];
  let github = false;
  const answers: (() => void)[] = [];
  const slot = (
    await changesTab(calls, {
      // GitHub takes the mark when it answers, so answers out of order would leave the wrong one.
      setViewed: (input: { viewed: boolean }) => {
        calls.push({ method: "setViewed", input });
        return new Promise((resolve) => {
          answers.push(() => {
            github = input.viewed;
            resolve({ viewed: input.viewed ? "viewed" : "unviewed" });
          });
        });
      },
    })
  ).render();
  await slot.findByText("1 of 3 files viewed");
  const box = () =>
    within(slot.getByRole("article", { name: "src/login.ts" })).getByRole("checkbox", {
      name: "Viewed src/login.ts",
    }) as HTMLInputElement;
  const write = (viewed: boolean) => ({
    method: "setViewed",
    input: { account: "scott", pullRequestId: "PR_kwDOA42", path: "src/login.ts", viewed },
  });

  fireEvent.click(box());
  await waitFor(() => expect(box().checked).toBe(true));
  fireEvent.click(box());
  await waitFor(() => expect(box().checked).toBe(false));

  // The second write waits for the first to be answered.
  await waitFor(() => expect(answers).toHaveLength(1));
  await new Promise((settle) => setTimeout(settle, 20));
  expect(calls).toEqual([write(true)]);
  answers[0]!();
  await waitFor(() => expect(calls).toEqual([write(true), write(false)]));
  answers[1]!();

  await waitFor(() => expect(github).toBe(false));
  expect(box().checked).toBe(false);
  expect(slot.getByText("1 of 3 files viewed")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a Viewed click after leaving the tab and coming back waits for the one before", async () => {
  const calls: Call[] = [];
  let github = false;
  const held: (() => void)[] = [];
  const { render } = await changesTab(calls, {
    // GitHub takes the mark when it answers, and the test says when.
    setViewed: (input: { viewed: boolean }) => {
      calls.push({ method: "setViewed", input });
      return new Promise((resolve) => {
        held.push(() => {
          github = input.viewed;
          resolve({ viewed: input.viewed ? "viewed" : "unviewed" });
        });
      });
    },
  });
  const box = (slot: ReturnType<typeof render>) =>
    within(slot.getByRole("article", { name: "src/login.ts" })).getByRole("checkbox", {
      name: "Viewed src/login.ts",
    }) as HTMLInputElement;
  const write = (viewed: boolean) => ({
    method: "setViewed",
    input: { account: "scott", pullRequestId: "PR_kwDOA42", path: "src/login.ts", viewed },
  });

  const first = render();
  await first.findByText("1 of 3 files viewed");
  fireEvent.click(box(first));
  await waitFor(() => expect(held).toHaveLength(1));
  first.lifecycle.unmount();

  const second = render();
  await waitFor(() => expect(box(second).checked).toBe(true));
  fireEvent.click(box(second));
  await waitFor(() => expect(box(second).checked).toBe(false));

  // The uncheck waits for the write from before the tab was left.
  await new Promise((settle) => setTimeout(settle, 20));
  expect(calls).toEqual([write(true)]);
  // GitHub answers the newest write it holds first, so the older one, if
  // still held, would land last.
  held.pop()!();
  await waitFor(() => expect(calls).toEqual([write(true), write(false)]));
  await new Promise((settle) => setTimeout(settle, 20));
  held.pop()!();

  await waitFor(() => expect(github).toBe(false));
  await new Promise((settle) => setTimeout(settle, 20));
  expect(github).toBe(false);
  expect(box(second).checked).toBe(false);
  expect(second.getByText("1 of 3 files viewed")).toBeTruthy();
  second.lifecycle.unmount();
});

test("a Viewed write that fails after leaving the tab and coming back says why in the new tab", async () => {
  const held: { resolve: (answer: unknown) => void; reject: (error: Error) => void }[] = [];
  const { render } = await changesTab([], {
    // GitHub answers each write when the test says, and how.
    setViewed: () => new Promise((resolve, reject) => held.push({ resolve, reject })),
  });
  const box = (slot: ReturnType<typeof render>) =>
    within(slot.getByRole("article", { name: "src/login.ts" })).getByRole("checkbox", {
      name: "Viewed src/login.ts",
    }) as HTMLInputElement;
  const failure = "Could not mark src/login.ts as viewed. GitHub is down.";

  const first = render();
  await first.findByText("1 of 3 files viewed");
  // The tab is left in the same moment, before it draws the mark or the write goes out.
  fireEvent.click(box(first));
  first.lifecycle.unmount();

  const second = render();
  await waitFor(() => expect(held).toHaveLength(1));
  expect(box(second).checked).toBe(true);
  await act(async () => held[0]!.reject(new Error("GitHub is down.")));

  expect(await second.findByText(failure)).toBeTruthy();
  expect(box(second).checked).toBe(false);
  expect(second.getByText("1 of 3 files viewed")).toBeTruthy();

  // The next write that lands for the file takes its error away.
  fireEvent.click(box(second));
  await waitFor(() => expect(held).toHaveLength(2));
  await act(async () => held[1]!.resolve({ viewed: "viewed" }));
  await waitFor(() => expect(second.queryByText(failure)).toBeNull());
  expect(box(second).checked).toBe(true);
  second.lifecycle.unmount();
});

test("a Viewed error is dismissed for good, and stays gone in the next visit", async () => {
  const { render } = await changesTab([], {
    setViewed: () => Promise.reject(new Error("GitHub is down.")),
  });
  const failure = "Could not mark src/login.ts as viewed. GitHub is down.";
  const first = render();
  await first.findByText("1 of 3 files viewed");
  const card = first.getByRole("article", { name: "src/login.ts" });
  fireEvent.click(within(card).getByRole("checkbox", { name: "Viewed src/login.ts" }));
  await first.findByText(failure);
  fireEvent.click(first.getByRole("button", { name: "Dismiss" }));
  expect(first.queryByText(failure)).toBeNull();
  first.lifecycle.unmount();

  const second = render();
  await second.findByText("1 of 3 files viewed");
  expect(second.queryByText(failure)).toBeNull();
  second.lifecycle.unmount();
});

test("folding a card from deep in its diff brings its header back to the top", async () => {
  const slot = (await changesTab()).render();
  await slot.findByText("1 of 3 files viewed");
  const login = slot.getByRole("article", { name: "src/login.ts" });
  const logo = slot.getByRole("article", { name: "assets/logo.png" });
  const area = login.closest<HTMLElement>("[data-cr-scroll]")!;
  // The scroll area starts 100px down, and the reader is 600px into login.ts.
  placeAt(area, 100, 900);
  placeAt(login, -500, 2_000);
  placeAt(logo, 2_008, 2_200);
  area.scrollTop = 3_000;

  fireEvent.click(within(login).getByRole("checkbox", { name: "Viewed src/login.ts" }));
  expect(diffBody(slot.getByRole("article", { name: "src/login.ts" })).hidden).toBe(true);
  // Its top lands 8px under the area's top: 3000 - 600 - 8.
  expect(area.scrollTop).toBe(2_392);

  // A card below the reader folds where it is.
  fireEvent.click(within(logo).getByRole("checkbox", { name: "Viewed assets/logo.png" }));
  expect(area.scrollTop).toBe(2_392);
  slot.lifecycle.unmount();
});

test("a reply on an outdated thread goes into the pending review", async () => {
  const calls: Call[] = [];
  const slot = (await changesTab(calls)).render();
  fireEvent.click(await slot.findByRole("button", { name: "1 outdated comment" }));
  expect(await slot.findByText("old note")).toBeTruthy();
  expect(slot.getAllByText("Pending")).toHaveLength(1);

  const outdated = within(slot.getByRole("region", { name: "Comment thread, line 9" }));
  fireEvent.click(outdated.getByRole("button", { name: "Reply…" }));
  const reply = sourceTextbox(outdated.getByRole("textbox", { name: "Reply" }));
  fireEvent.change(reply, { target: { value: "  Still true after the push.  " } });
  fireEvent.keyDown(reply, { key: "Enter", ctrlKey: true });

  await waitFor(() =>
    expect(calls).toEqual([
      {
        method: "replyDraft",
        input: {
          account: "scott",
          pullRequestId: "PR_kwDOA42",
          threadId: "T2",
          body: "Still true after the push.",
        },
      },
    ]),
  );
  slot.lifecycle.unmount();
});

test("deleting a draft asks first, then deletes only that comment", async () => {
  const calls: Call[] = [];
  const slot = (await changesTab(calls)).render();
  fireEvent.click(await slot.findByRole("button", { name: "1 outdated comment" }));
  fireEvent.click(await slot.findByRole("button", { name: "Delete draft comment" }));

  expect(slot.getByText("Delete this draft comment?")).toBeTruthy();
  expect(calls).toEqual([]);
  fireEvent.click(slot.getByRole("button", { name: "Delete" }));

  await waitFor(() =>
    expect(calls).toEqual([
      { method: "deleteDraft", input: { account: "scott", commentId: "C2" } },
    ]),
  );
  slot.lifecycle.unmount();
});

test("a failed draft edit reopens with the text that was not saved", async () => {
  const slot = (
    await changesTab([], {
      editDraft: () => {
        throw new Error("GitHub refused the edit");
      },
    })
  ).render();
  fireEvent.click(await slot.findByRole("button", { name: "1 outdated comment" }));
  fireEvent.click(await slot.findByRole("button", { name: "Edit draft comment" }));
  const box = sourceTextbox(slot.getByRole("textbox", { name: "Edit draft comment" }));
  fireEvent.change(box, { target: { value: "My better wording" } });
  fireEvent.click(slot.getByRole("button", { name: "Save" }));

  const reopened = await slot
    .findByRole("textbox", { name: "Edit draft comment" })
    .then(sourceTextbox);
  await waitFor(() => expect((reopened as HTMLTextAreaElement).value).toBe("My better wording"));
  expect(slot.getAllByText(/GitHub refused the edit/).length).toBeGreaterThan(0);
  slot.lifecycle.unmount();
});

test("a Show in Changes request sent before the tab mounts opens that file", async () => {
  const { render } = await changesTab();
  window.dispatchEvent(
    new window.CustomEvent(REVEAL_EVENT, {
      detail: { path: "docs/old.md", line: 2, side: "LEFT" },
    }),
  );
  const slot = render();

  // The viewed file starts folded, and the request opens it.
  await waitFor(() =>
    expect(diffBody(slot.getByRole("article", { name: "docs/old.md" })).hidden).toBe(false),
  );
  slot.lifecycle.unmount();
});

test("a Show in Changes request waits out a slow first load", async () => {
  let load: (() => void) | null = null;
  const slot = (
    await changesTab([], {
      changedFiles: () =>
        new Promise((resolve) => {
          load = () => resolve(files);
        }),
    })
  ).render();
  await waitFor(() => expect(load).not.toBeNull());
  act(() => {
    window.dispatchEvent(
      new window.CustomEvent(REVEAL_EVENT, {
        detail: { path: "docs/old.md", line: 2, side: "LEFT" },
      }),
    );
  });

  setSystemTime(new Date(Date.now() + 10_000));
  try {
    load!();
    await waitFor(() =>
      expect(diffBody(slot.getByRole("article", { name: "docs/old.md" })).hidden).toBe(false),
    );
  } finally {
    setSystemTime();
    slot.lifecycle.unmount();
  }
});

test("a request no tab took in time is ignored by a later visit", async () => {
  const { render } = await changesTab();
  window.dispatchEvent(
    new window.CustomEvent(REVEAL_EVENT, {
      detail: { path: "docs/old.md", line: 2, side: "LEFT" },
    }),
  );

  setSystemTime(new Date(Date.now() + 10_000));
  const slot = render();
  try {
    await slot.findByText("1 of 3 files viewed");
    expect(diffBody(slot.getByRole("article", { name: "docs/old.md" })).hidden).toBe(true);
  } finally {
    setSystemTime();
    slot.lifecycle.unmount();
  }
});

/** The viewer's draft on a file a later push reverted. */
const revertedDraft = thread({
  id: "T3",
  path: "src/reverted.ts",
  comments: [
    {
      id: "C3",
      author: { login: "scott", avatarUrl: null },
      body: "note on a reverted file",
      createdAt: "2026-01-02T10:00:00Z",
      url: "https://github.com/acme/api/pull/42#discussion_r3",
      isDraft: true,
    },
  ],
});

test("a thread on a file no longer in the diff is listed below the files, drafts and all", async () => {
  const calls: Call[] = [];
  const withReverted: PullRequest = { ...pr, threads: [...pr.threads, revertedDraft] };
  const slot = (await changesTab(calls, { pullRequest: () => withReverted })).render();

  const section = within(
    await slot.findByRole("region", { name: "Comments on files no longer in the diff" }),
  );
  const reverted = within(section.getByRole("region", { name: "src/reverted.ts" }));
  expect(reverted.getByText("note on a reverted file")).toBeTruthy();
  // Only the thread with no card is listed here.
  expect(section.queryByText("Why three?")).toBeNull();

  fireEvent.click(reverted.getByRole("button", { name: "Delete draft comment" }));
  fireEvent.click(reverted.getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(calls).toEqual([
      { method: "deleteDraft", input: { account: "scott", commentId: "C3" } },
    ]),
  );
  slot.lifecycle.unmount();
});

test("when a push reverts every file, its drafts are still listed to delete", async () => {
  const calls: Call[] = [];
  const slot = (
    await changesTab(calls, {
      pullRequest: () => ({ ...pr, threads: [revertedDraft] }),
      changedFiles: () => ({ ...files, files: [] }),
    })
  ).render();

  expect(await slot.findByText("No changed files")).toBeTruthy();
  const section = within(
    await slot.findByRole("region", { name: "Comments on files no longer in the diff" }),
  );
  const reverted = within(section.getByRole("region", { name: "src/reverted.ts" }));
  expect(reverted.getByText("note on a reverted file")).toBeTruthy();

  fireEvent.click(reverted.getByRole("button", { name: "Delete draft comment" }));
  fireEvent.click(reverted.getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(calls).toEqual([
      { method: "deleteDraft", input: { account: "scott", commentId: "C3" } },
    ]),
  );
  slot.lifecycle.unmount();
});

test("a pull request moved to another base reads its changed files again", async () => {
  let reads = 0;
  const slot = (
    await changesTab([], {
      pullRequest: () => ({ ...pr, baseRefName: "release" }),
      // The first read compares against `main`, from before the move.
      changedFiles: () => {
        reads++;
        return reads === 1
          ? files
          : { ...files, baseRefName: "release", files: files.files.slice(0, 1) };
      },
    })
  ).render();

  expect(await slot.findByText("0 of 1 file viewed")).toBeTruthy();
  expect(reads).toBe(2);
  slot.lifecycle.unmount();
});

/**
 * The Changes tab of `pull`. Its first read of the files answers `first` at
 * once, and every later one waits in `held` for the test to answer.
 */
async function heldFiles(first: ChangedFiles, pull: () => PullRequest) {
  let answered = false;
  const held: ((answer: ChangedFiles) => void)[] = [];
  const slot = (
    await changesTab([], {
      pullRequest: pull,
      changedFiles: () => {
        if (answered) return new Promise((resolve) => held.push(resolve));
        answered = true;
        return first;
      },
    })
  ).render();
  return { slot, held };
}

/** Moves the fake clock on, then lets what it set off land and draw. */
const tick = (ms: number) =>
  act(async () => {
    jest.advanceTimersByTime(ms);
    await new Promise((settle) => setImmediate(settle));
    jest.advanceTimersByTime(0);
  });

const BEHIND = "The diff is behind the pull request";

/**
 * Answers the newest held read with each of `answers` in turn, under fake
 * timers, all behind the pull request. The next read goes out 1, 3, then 10
 * seconds after each answer, none follows the fourth, and only then does the
 * tab say the diff is behind.
 */
async function expectRetries(
  { slot, held }: Awaited<ReturnType<typeof heldFiles>>,
  answers: readonly ChangedFiles[],
) {
  const reads = held.length;
  for (const [index, delay] of [1_000, 3_000, 10_000].entries()) {
    await act(async () => held.at(-1)!(answers[index]!));
    await tick(delay - 100);
    expect(held).toHaveLength(reads + index);
    await tick(200);
    expect(held).toHaveLength(reads + index + 1);
    expect(slot.queryByText(BEHIND)).toBeNull();
  }
  await act(async () => held.at(-1)!(answers[3]!));
  await tick(60_000);
  expect(held).toHaveLength(reads + 3);
  expect(slot.getByText(BEHIND)).toBeTruthy();
}

test("files still behind after a read are read again later, then offer a refresh", async () => {
  const caughtUp: ChangedFiles = {
    ...files,
    baseRefName: "release",
    files: files.files.slice(0, 1),
  };
  let prReads = 0;
  const tab = await heldFiles(files, () => {
    prReads++;
    return { ...pr, baseRefName: "release" };
  });
  const { slot, held } = tab;
  await slot.findByText("1 of 3 files viewed");
  // The files compare against `main`, so they are read again at once.
  await waitFor(() => expect(held).toHaveLength(1));

  jest.useFakeTimers();
  try {
    // GitHub answers every read as old as the first, still against `main`.
    await expectRetries(tab, [files, files, files, files]);
    expect(slot.getByText("1 of 3 files viewed")).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }

  // Two clicks before the first read lands make one read of each, and the files catch up.
  const prReadsBefore = prReads;
  const refresh = slot.getByRole("button", { name: "Refresh" });
  fireEvent.click(refresh);
  fireEvent.click(refresh);
  await waitFor(() => expect(held).toHaveLength(5));
  await new Promise((settle) => setTimeout(settle, 20));
  expect(held).toHaveLength(5);
  expect(prReads).toBe(prReadsBefore + 1);
  act(() => held[4]!(caughtUp));

  expect(await slot.findByText("0 of 1 file viewed")).toBeTruthy();
  expect(slot.queryByText(BEHIND)).toBeNull();

  // A later read that slips back behind gets fresh tries, not the spent ones.
  act(() => {
    void queryClient.invalidateQueries({
      queryKey: queryKey("changedFiles", { account: pr.account, ref: pr.ref }),
    });
  });
  await waitFor(() => expect(held).toHaveLength(6));
  await act(async () => held[5]!(files));
  await waitFor(() => expect(held).toHaveLength(7));
  expect(slot.getByText("1 of 3 files viewed")).toBeTruthy();
  expect(slot.queryByText(BEHIND)).toBeNull();

  jest.useFakeTimers();
  try {
    await expectRetries(tab, [files, files, files, files]);
  } finally {
    jest.useRealTimers();
  }
  slot.lifecycle.unmount();
});

/** The files as of an older push, the one whose head is `digit` forty times. */
const olderPush = (digit: string): ChangedFiles => ({ ...files, headRefOid: digit.repeat(40) });

test("reads that come back as one older push, then another, keep to the same tries", async () => {
  const tab = await heldFiles(olderPush("3"), () => pr);
  await tab.slot.findByText("1 of 3 files viewed");
  await waitFor(() => expect(tab.held).toHaveLength(1));

  jest.useFakeTimers();
  try {
    // GitHub's replicas take turns answering, each from a different old push.
    await expectRetries(tab, [olderPush("4"), olderPush("3"), olderPush("4"), olderPush("3")]);
  } finally {
    jest.useRealTimers();
  }
  tab.slot.lifecycle.unmount();
});

test("a push to the pull request starts its spent tries over", async () => {
  let current: PullRequest = pr;
  const tab = await heldFiles(olderPush("3"), () => current);
  const { slot, held } = tab;
  await slot.findByText("1 of 3 files viewed");
  await waitFor(() => expect(held).toHaveLength(1));

  jest.useFakeTimers();
  try {
    await expectRetries(tab, [olderPush("3"), olderPush("3"), olderPush("3"), olderPush("3")]);

    // The pull request moves on, and the files are read again at once.
    current = { ...pr, headRefOid: "5".repeat(40) };
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKey("pullRequest", { account: pr.account, ref: pr.ref }),
      });
    });
    await tick(0);
    expect(held).toHaveLength(5);
    expect(slot.queryByText(BEHIND)).toBeNull();
    await expectRetries(tab, [olderPush("3"), olderPush("3"), olderPush("3"), olderPush("3")]);
  } finally {
    jest.useRealTimers();
  }
  slot.lifecycle.unmount();
});

test("findings from a review against another base are marked as older", async () => {
  const slot = (
    await changesTab([], {
      agentActivity: () => ({
        threads: [],
        latestReview: {
          threadId: "R1",
          headRefOid: pr.headRefOid,
          baseRefName: "develop",
          reportedAt: "2026-01-02T10:00:00Z",
          summary: null,
          findings: [],
        },
      }),
    })
  ).render();

  expect(await slot.findByText("bb findings are from an older version of this diff")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a new comment on a range is one addDraftComment, then the form reports the thread", async () => {
  const calls: Call[] = [];
  const saved: string[] = [];
  let closed = 0;
  const Form = () => (
    <QueryClientProvider client={queryClient}>
      <NewCommentForm
        pr={pr}
        headRefOid="abc123"
        baseRefName="main"
        path="src/login.ts"
        target={{ line: 5, side: "RIGHT", startLine: 2, startSide: "LEFT" }}
        onSaved={(threadId) => saved.push(threadId)}
        onClose={() => closed++}
      />
    </QueryClientProvider>
  );
  const slot = renderSlot({ component: Form }, {}, { rpc: handlers(calls) as never });

  const box = sourceTextbox(
    slot.getByRole("textbox", { name: "Comment on lines 2 (base) to 5 of src/login.ts" }),
  );
  const submit = slot.getByRole("button", { name: "Add review comment" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(box, { target: { value: "  Needs a test  " } });
  fireEvent.click(submit);

  await waitFor(() => expect(saved).toEqual(["TNEW"]));
  expect(calls).toEqual([
    {
      method: "addDraftComment",
      input: {
        account: "scott",
        pullRequestId: "PR_kwDOA42",
        headRefOid: "abc123",
        baseRefName: "main",
        path: "src/login.ts",
        body: "Needs a test",
        line: 5,
        startLine: 2,
        side: "RIGHT",
        startSide: "LEFT",
      },
    },
  ]);
  fireEvent.click(await slot.findByRole("button", { name: "Close" }));
  expect(closed).toBe(1);
  slot.lifecycle.unmount();
});

test("a Viewed error belongs to the account that wrote it, not to another reading the same pull request", async () => {
  const { panel } = await changesTab();
  const rpc = {
    ...handlers([]),
    status: () => ({ ok: true, login: "scott", accounts: ["scott", "scott-work"] }),
    pullRequest: (input: { account: string }) => ({ ...pr, account: input.account }),
    setViewed: () => Promise.reject(new Error("GitHub is down.")),
  } as never;
  const failure = "Could not mark src/login.ts as viewed. GitHub is down.";
  const open = (account: string) =>
    renderSlot(panel, { subPath: `@${account}/${CHANGES}` }, { rpc });

  const scott = open("scott");
  await scott.findByText("1 of 3 files viewed");
  const card = scott.getByRole("article", { name: "src/login.ts" });
  fireEvent.click(within(card).getByRole("checkbox", { name: "Viewed src/login.ts" }));
  await scott.findByText(failure);
  scott.lifecycle.unmount();

  const work = open("scott-work");
  await work.findByText("1 of 3 files viewed");
  expect(work.queryByText(failure)).toBeNull();
  work.lifecycle.unmount();

  const again = open("scott");
  expect(await again.findByText(failure)).toBeTruthy();
  fireEvent.click(again.getByRole("button", { name: "Dismiss" }));
  again.lifecycle.unmount();
});

test("comment text typed as one account does not open in the form of another", () => {
  const Form = ({ account }: { account: string }) => (
    <QueryClientProvider client={queryClient}>
      <NewCommentForm
        pr={{ ...pr, account }}
        headRefOid="abc123"
        baseRefName="main"
        path="src/login.ts"
        target={{ line: 5, side: "RIGHT", startLine: null, startSide: null }}
        onSaved={() => {}}
        onClose={() => {}}
      />
    </QueryClientProvider>
  );
  const name = "Comment on line 5 of src/login.ts";
  const typed = renderSlot({ component: () => <Form account="scott" /> }, {}, { rpc: {} as never });
  fireEvent.change(sourceTextbox(typed.getByRole("textbox", { name })), {
    target: { value: "Needs a test" },
  });
  typed.lifecycle.unmount();

  const other = renderSlot(
    { component: () => <Form account="scott-work" /> },
    {},
    { rpc: {} as never },
  );
  expect((sourceTextbox(other.getByRole("textbox", { name })) as HTMLTextAreaElement).value).toBe(
    "",
  );
  other.lifecycle.unmount();

  const again = renderSlot({ component: () => <Form account="Scott" /> }, {}, { rpc: {} as never });
  expect((sourceTextbox(again.getByRole("textbox", { name })) as HTMLTextAreaElement).value).toBe(
    "Needs a test",
  );
  again.lifecycle.unmount();
});

// Existing draft/save scenarios use the optional source editor explicitly.
function sourceTextbox(element: HTMLElement): HTMLElement {
  if (!element.matches(".tiptap")) return element;
  const wrapper = element.closest(".bb-markdown-editor");
  const button = [...(wrapper?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent === "Markdown source",
  );
  if (!button) throw new Error("Markdown editor has no source control");
  fireEvent.click(button);
  const source = wrapper?.querySelector<HTMLElement>("textarea[data-markdown-source]");
  if (!source) throw new Error("Source mode did not open");
  return source;
}
