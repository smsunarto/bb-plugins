// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { changeKeySchema, reviewTag, type ChangeKey } from "../../core/ids.ts";
import type {
  BatchInput,
  BatchView,
  ChangeReview,
  Draft,
  DraftInput,
  ReviewItem,
} from "../../core/items.ts";
import { reviewPath, type ChangeDetail, type ChangeRow } from "../../core/review.ts";
import { sourceControlContract } from "../../contract/rpc.ts";
import { ChangeDirective } from "../chat-card.tsx";
import { FindingsCard } from "../findings-card.tsx";
import { resetPendingChecks } from "../review-data.ts";
import { ReviewPanel } from "../review-entry.tsx";
import { patchLines } from "../review-model.ts";
import { annotationProbe } from "./annotations.tsx";
import { resetNavStores } from "./sources.ts";
import { resetPatchStores } from "./patches.ts";

// Pierre's diff element adopts a constructed stylesheet; jsdom has no `replaceSync`.
const sheet = CSSStyleSheet.prototype as unknown as { replaceSync?: (text: string) => void };
sheet.replaceSync ??= () => {};
// Pierre's diff watches its own size; jsdom has no ResizeObserver, and nothing here is laid out.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const KEY: ChangeKey = changeKeySchema.parse("local:host-a:/work/.git:scott/local");
const HEAD = "c0ffee1";
const PATH = "src/a.ts";
const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " one",
  "-two",
  "+TWO",
  "+three",
  " four",
  "",
].join("\n");

const ROW: ChangeRow = {
  key: KEY,
  repo: "bb-plugins",
  title: "A local change",
  branch: "scott/local",
  baseRef: "main",
  number: null,
  url: null,
  author: "smsunarto",
  state: "local",
  mine: true,
  asked: false,
  stack: null,
  hostId: "host-a",
  line: "Local",
  chips: [],
  sort: 6,
  updatedAt: new Date().toISOString(),
};

// A Change with no pull request: its files come from the checkout host.
const DETAIL: ChangeDetail = {
  state: "change",
  row: ROW,
  head: HEAD,
  files: 1,
  additions: 2,
  deletions: 1,
  revision: { head: HEAD, base: "b0", source: { kind: "host", hostId: "host-a", path: "/work" } },
  stack: null,
  canMarkReady: false,
  ship: [],
  problem: null,
  at: Date.now(),
};

function finding(n: number, line: number): ReviewItem {
  return {
    id: `bb:thread-r:${n}`,
    origin: { kind: "bb", threadId: "thread-r" },
    priority: n === 1 ? 0 : 2,
    title: `Finding ${n}`,
    body: `Body of finding ${n}.`,
    anchor: { path: PATH, line, startLine: null, side: "RIGHT", head: HEAD },
    state: "open",
    url: null,
    createdAt: new Date().toISOString(),
    replies: [],
  };
}

/** A GitHub thread's item, which a reader answers with Reply. */
function comment(n: number, line: number): ReviewItem {
  return {
    ...finding(n, line),
    id: `gh:thread-${n}`,
    origin: { kind: "forge", author: "mira", bot: false, slopcop: false },
    priority: null,
    title: null,
    body: `Comment ${n}.`,
  };
}

/** The server's review store, as the handlers below keep it. */
function reviewServer(items: ReviewItem[], extra: Partial<ChangeReview> = {}) {
  const state: ChangeReview = {
    items,
    drafts: [],
    selected: [],
    runs: [],
    forge: { at: null, problem: null },
    batches: [],
    tray: { destination: "agent", target: null },
    viewer: null,
    ...extra,
  };
  const saved: DraftInput[] = [];
  const sent: BatchInput[] = [];
  const handlers: Partial<Handlers> = {
    reviewForChange: ({ keys }) =>
      Object.fromEntries(keys.map((key) => [key, structuredClone(state)])),
    setSelected: ({ ids, selected }) => {
      const set = new Set(state.selected);
      for (const id of ids) {
        if (selected) set.add(id);
        else set.delete(id);
      }
      state.selected = [...set];
      return { ok: true as const };
    },
    saveDraft: ({ draft }) => {
      saved.push(draft);
      const stored: Draft = { ...draft, state: "pending", createdAt: 1, updatedAt: 1 };
      state.drafts = [...state.drafts.filter((old) => old.id !== draft.id), stored];
      return { ok: true as const, draft: stored };
    },
    deleteDraft: ({ id }) => {
      state.drafts = state.drafts.filter((draft) => draft.id !== id);
      return { ok: true as const };
    },
    dismissItem: ({ id }) => {
      state.items = state.items.filter((item) => item.id !== id);
      state.selected = state.selected.filter((selected) => selected !== id);
      return { ok: true as const };
    },
    setTray: ({ tray }) => {
      state.tray = tray;
      return { ok: true as const };
    },
    agentTargets: () => ({
      targets: [
        { threadId: "thread-a", title: "Source control core", status: "idle", onChange: true },
      ],
    }),
    sendBatch: ({ batch }) => {
      sent.push(batch);
      const view: BatchView = {
        ...batch,
        state: "sent",
        phase: "fixing",
        problem: null,
        createdAt: 1,
        sentAt: 2,
        threadId: batch.target.kind === "thread" ? batch.target.threadId : "thread-new",
        url: null,
        agent: "running",
      };
      state.batches = [view, ...state.batches.filter((old) => old.id !== batch.id)];
      state.selected = state.selected.filter((id) => !batch.itemIds.includes(id));
      return view;
    },
    stopAgent: () => ({ ok: true as const }),
  };
  return { state, saved, sent, handlers };
}

type Handlers = PluginRpcTestHandlers<typeof sourceControlContract>;

/** The review page and the thread tab's card, both on screen, as when the page is split beside a thread. */
function Both() {
  return (
    <>
      <ReviewPanel subPath={reviewPath({ key: KEY })} />
      <div data-testid="thread-tab">
        <FindingsCard changeKey={KEY} threadId="thread-a" head={HEAD} visible />
      </div>
    </>
  );
}

function render(review: Partial<Handlers>, detail: ChangeDetail = DETAIL) {
  return renderSlot(
    { component: Both },
    {},
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      rpc: {
        changeDetail: ({ keys }) => Object.fromEntries(keys.map((key) => [key, detail])),
        checksForChange: ({ keys }) =>
          Object.fromEntries(keys.map((key) => [key, { read: null, problem: null }])),
        changeFiles: () => ({
          ok: true as const,
          files: [
            {
              path: PATH,
              kind: "modified" as const,
              previousPath: null,
              additions: 2,
              deletions: 1,
              binary: false,
            },
          ],
          more: false,
        }),
        changePatches: () => ({
          ok: true as const,
          value: {
            files: [
              {
                path: PATH,
                kind: "modified" as const,
                previousPath: null,
                patch: PATCH,
                truncated: false,
              },
            ],
          },
        }),
        startReview: () => ({ ok: true as const, threadId: "thread-r", reused: false }),
        ...review,
      } as Handlers,
    },
  );
}

const checked = (element: Element) => String((element as HTMLInputElement).checked);

beforeEach(() => {
  localStorage.clear();
  resetNavStores();
  resetPendingChecks();
  resetPatchStores();
  annotationProbe.onRender = null;
});
afterEach(cleanup);

test("checking an item in the rail checks it in the diff's annotation and the thread tab's card", async () => {
  const server = reviewServer([finding(1, 2)]);
  const slot = render(server.handlers);
  const rail = await slot.findByTestId("sc-rail-review");
  const railBox = await within(rail).findByTestId("sc-review-check");
  const annotationBox = await slot.findByTestId("sc-annotation-check");
  const cardBox = within(slot.getByTestId("thread-tab")).getByTestId("sc-finding-check");
  expect([railBox, annotationBox, cardBox].map(checked)).toEqual(["false", "false", "false"]);

  fireEvent.click(railBox);
  // Predicted at once in the one shared entry: every surface shows it before the server answers.
  expect(
    [
      within(rail).getByTestId("sc-review-check"),
      slot.getByTestId("sc-annotation-check"),
      within(slot.getByTestId("thread-tab")).getByTestId("sc-finding-check"),
    ].map(checked),
  ).toEqual(["true", "true", "true"]);
  await waitFor(() => expect(server.state.selected).toEqual([finding(1, 2).id]));

  // The server's read stays the truth: it agrees, so nothing flips back.
  await slot.experimental_invalidateRpc([reviewTag(KEY)]);
  await waitFor(() =>
    expect(
      [
        within(rail).getByTestId("sc-review-check"),
        slot.getByTestId("sc-annotation-check"),
        within(slot.getByTestId("thread-tab")).getByTestId("sc-finding-check"),
      ].map(checked),
    ).toEqual(["true", "true", "true"]),
  );

  // And back from the annotation.
  fireEvent.click(slot.getByTestId("sc-annotation-check"));
  expect(checked(within(slot.getByTestId("thread-tab")).getByTestId("sc-finding-check"))).toBe(
    "false",
  );
  expect(checked(within(rail).getByTestId("sc-review-check"))).toBe("false");
});

test("typing in one comment composer redraws no line's annotations", async () => {
  const server = reviewServer([comment(1, 2), comment(2, 4)]);
  const slot = render(server.handlers);
  await waitFor(() => expect(slot.getAllByTestId("sc-annotation")).toHaveLength(2));
  const [first] = slot.getAllByTestId("sc-annotation");
  fireEvent.click(within(first!).getByTestId("sc-reply"));
  const box = await within(first!).findByRole("textbox", { name: "Reply" });

  const renders = new Map<string, number>();
  annotationProbe.onRender = (key) => renders.set(key, (renders.get(key) ?? 0) + 1);
  for (const text of ["K", "Ke", "Key", "Key it by account"])
    fireEvent.change(box, { target: { value: text } });
  expect((box as HTMLTextAreaElement).value).toBe("Key it by account");
  // Neither the composer's own line nor its sibling drew again: the text lives in the composer.
  expect(renders.get("additions:2") ?? 0).toBe(0);
  expect(renders.get("additions:4") ?? 0).toBe(0);

  // The probe does count: checking the first item redraws its line, and only its line.
  fireEvent.click(within(first!).getByTestId("sc-annotation-check"));
  expect(renders.get("additions:2") ?? 0).toBeGreaterThan(0);
  expect(renders.get("additions:4") ?? 0).toBe(0);
  // The composer kept its text through that redraw.
  expect(
    (within(first!).getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement).value,
  ).toBe("Key it by account");
});

test("a reply is saved once under its client id, shows as Pending, and can be deleted", async () => {
  const server = reviewServer([comment(1, 2)]);
  const slot = render(server.handlers);
  const annotation = await slot.findByTestId("sc-annotation");
  fireEvent.click(within(annotation).getByTestId("sc-reply"));
  const box = await within(annotation).findByRole("textbox", { name: "Reply" });
  fireEvent.change(box, { target: { value: "Key it by account and repo." } });
  fireEvent.click(within(annotation).getByRole("button", { name: "Add reply" }));

  const draft = await within(slot.getByTestId("sc-annotation")).findByTestId("sc-draft");
  expect(draft.textContent).toContain("Pending");
  expect(draft.textContent).toContain("Key it by account and repo.");
  expect(server.saved).toHaveLength(1);
  expect(server.saved[0]).toMatchObject({
    body: "Key it by account and repo.",
    replyTo: comment(1, 2).id,
    // A local change with no pull request: the anchor names the head the diff shows.
    anchor: { path: PATH, line: 2, side: "RIGHT", head: HEAD },
  });
  expect(draft.getAttribute("data-draft")).toBe(server.saved[0]!.id);

  fireEvent.click(within(draft).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(slot.queryByTestId("sc-draft")).toBeNull());
  expect(server.state.drafts).toEqual([]);
});

test("Review with bb starts a review and says so", async () => {
  const server = reviewServer([]);
  const slot = render(server.handlers);
  const start = await slot.findByTestId("sc-review-start");
  expect(start.textContent).toBe("Review with bb");
  await act(async () => {
    fireEvent.click(start);
  });
  expect(await slot.findByText("Review started")).toBeTruthy();
});

test("an outdated item whose line this diff does not show is listed at the top of its file", async () => {
  const moved: ReviewItem = {
    ...finding(3, 9),
    state: "outdated",
    anchor: { path: PATH, line: 9, startLine: null, side: "RIGHT", head: "0ld0000" },
  };
  const server = reviewServer([finding(1, 2), moved]);
  const slot = render(server.handlers);
  await waitFor(() => expect(slot.getAllByTestId("sc-annotation")).toHaveLength(2));
  const top = slot
    .getAllByTestId("sc-line-thread")
    .find((thread) => thread.dataset.line === "file");
  expect(top).toBeTruthy();
  expect(within(top!).getByTestId("sc-annotation").dataset.item).toBe(moved.id);
  expect(top!.textContent).toContain("Outdated");
  // It sits above the diff; the current item sits under its line inside it.
  const diff = slot.getByTestId("sc-patch").querySelector("diffs-container");
  expect(diff?.contains(top!)).toBe(false);
  const onLine = slot
    .getAllByTestId("sc-line-thread")
    .find((thread) => thread.dataset.line === "additions:2");
  expect(diff?.contains(onLine!)).toBe(true);
});

test("the lines a patch shows, by side, with their unified row", () => {
  const { rows } = patchLines(PATCH);
  expect([...rows]).toEqual([
    ["deletions:1", 1],
    ["additions:1", 1],
    ["deletions:2", 2],
    ["additions:2", 3],
    ["additions:3", 4],
    ["deletions:3", 5],
    ["additions:4", 5],
  ]);
});

// ── Sending ────────────────────────────────────────────────────────────

const PR_DETAIL: ChangeDetail = {
  ...DETAIL,
  row: { ...ROW, repo: "smsunarto/bb-plugins", number: 482, state: "draft", url: null },
};

function failedBatch(): BatchView {
  return {
    id: "batch-1",
    head: HEAD,
    itemIds: [finding(1, 2).id],
    draftIds: [],
    destination: "agent",
    target: { kind: "thread", threadId: "thread-a" },
    state: "failed",
    phase: "failed",
    problem: { kind: "failed", site: "bb", detail: "The thread refused it." },
    createdAt: 1,
    sentAt: null,
    threadId: "thread-a",
    url: null,
    agent: null,
  };
}

test("the tray lists what was checked in the rail, an annotation and the thread card, from one entry", async () => {
  const server = reviewServer([finding(1, 2), finding(2, 3), finding(3, 4)]);
  const slot = render(server.handlers);
  const rail = await slot.findByTestId("sc-rail-review");
  await waitFor(() => expect(slot.getAllByTestId("sc-annotation")).toHaveLength(3));
  const card = slot.getByTestId("thread-tab");

  fireEvent.click(within(rail).getAllByTestId("sc-review-check")[0]!);
  fireEvent.click(
    within(slot.getAllByTestId("sc-annotation")[1]!).getByTestId("sc-annotation-check"),
  );
  fireEvent.click(within(card).getAllByTestId("sc-finding-check")[2]!);

  const send = slot.getByTestId("sc-send");
  expect(send.textContent).toBe("Send 3 to agent");
  fireEvent.click(send);
  const tray = await slot.findByTestId("sc-tray");
  expect(
    within(tray)
      .getAllByTestId("sc-tray-item")
      .map((row) => row.dataset.item),
  ).toEqual([finding(1, 2).id, finding(2, 3).id, finding(3, 4).id]);
  // The thread on this branch is the default target, once the server lists it.
  await waitFor(() =>
    expect(within(tray).getByTestId("sc-tray-recipient").textContent).toBe("Source control core"),
  );

  // Remove unchecks it everywhere.
  fireEvent.click(within(within(tray).getAllByTestId("sc-tray-item")[1]!).getByText("Remove"));
  expect(checked(within(card).getAllByTestId("sc-finding-check")[1]!)).toBe("false");
  expect(slot.getByTestId("sc-send").textContent).toBe("Send 2 to agent");

  fireEvent.click(within(tray).getByTestId("sc-tray-send"));
  await waitFor(() => expect(server.sent).toHaveLength(1));
  expect(server.sent[0]).toMatchObject({
    head: HEAD,
    itemIds: [finding(1, 2).id, finding(3, 4).id],
    destination: "agent",
    target: { kind: "thread", threadId: "thread-a" },
  });
  // Sent: the pill says what the agent is doing, and the rail rows show progress.
  await slot.experimental_invalidateRpc([reviewTag(KEY)]);
  await waitFor(() =>
    expect(slot.getByTestId("sc-batch-pill").textContent).toContain("Agent fixing 2"),
  );
  expect(within(rail).getAllByTestId("sc-review-fixing")).toHaveLength(2);
});

test("the destination toggle changes the send label; GitHub is off with a reason without a pull request", async () => {
  const local = render(reviewServer([finding(1, 2)]).handlers);
  const github = await local.findByTestId("sc-destination-github");
  expect((github as HTMLButtonElement).disabled).toBe(true);
  expect(github.closest("label")!.getAttribute("title")).toBe(
    "This change has no pull request on GitHub yet.",
  );
  cleanup();

  const server = reviewServer([finding(1, 2)], { selected: [finding(1, 2).id] });
  const slot = render(server.handlers, PR_DETAIL);
  const toggle = await slot.findByTestId("sc-destination-github");
  await waitFor(() => expect(slot.getByTestId("sc-send").textContent).toBe("Send 1 to agent"));
  fireEvent.click(slot.getByTestId("sc-send"));
  expect((await slot.findByTestId("sc-tray-send")).textContent).toBe("Send 1");
  fireEvent.click(toggle);
  expect(slot.getByTestId("sc-send").textContent).toBe("Submit to GitHub");
  expect(slot.getByTestId("sc-tray-send").textContent).toBe("Submit 1");
  await waitFor(() => expect(server.state.tray.destination).toBe("github"));
});

test("a failed batch says why and Retry sends it again under the same id", async () => {
  const server = reviewServer([finding(1, 2)], { batches: [failedBatch()] });
  const slot = render(server.handlers);
  const banner = await slot.findByTestId("sc-batch-banner");
  expect(banner.textContent).toContain("Reading from bb failed.");
  fireEvent.click(within(banner).getByTestId("sc-batch-retry"));
  await waitFor(() => expect(server.sent).toHaveLength(1));
  const { id, head, itemIds, draftIds, destination, target } = failedBatch();
  expect(server.sent[0]).toEqual({ id, head, itemIds, draftIds, destination, target });
});

test("Dismiss takes a bb finding out of the rail, the diff and the card at once", async () => {
  const server = reviewServer([finding(1, 2), finding(2, 4)]);
  const slot = render(server.handlers);
  await waitFor(() => expect(slot.getAllByTestId("sc-annotation")).toHaveLength(2));
  fireEvent.click(within(slot.getAllByTestId("sc-annotation")[0]!).getByTestId("sc-dismiss"));
  expect(slot.getAllByTestId("sc-annotation")).toHaveLength(1);
  expect(within(slot.getByTestId("thread-tab")).getAllByTestId("sc-finding")).toHaveLength(1);
  await waitFor(() =>
    expect(server.state.items.map((item) => item.id)).toEqual([finding(2, 4).id]),
  );
});

test("drafts and composers name the reader by their GitHub login", async () => {
  const server = reviewServer([comment(1, 2)], {
    viewer: { login: "smsunarto", avatarUrl: null },
  });
  const slot = render(server.handlers);
  const annotation = await slot.findByTestId("sc-annotation");
  fireEvent.click(within(annotation).getByTestId("sc-reply"));
  await waitFor(() =>
    expect(within(annotation).getByTestId("sc-me").textContent).toBe("smsunarto"),
  );
});

test("the thread card shows the top five in the rail's order, then Show all", async () => {
  const items = [1, 2, 3, 4, 5, 6, 7].map((n) => finding(n, 2));
  const slot = render(reviewServer(items).handlers);
  const card = slot.getByTestId("thread-tab");
  await waitFor(() => expect(within(card).getAllByTestId("sc-finding")).toHaveLength(5));
  // P0 first: finding 1 is the only P0.
  expect(within(card).getAllByTestId("sc-finding")[0]!.dataset.item).toBe(finding(1, 2).id);
  const more = within(card).getByTestId("sc-findings-more");
  expect(more.textContent).toBe("Show all 7");
  fireEvent.click(more);
  expect(within(card).getAllByTestId("sc-finding")).toHaveLength(7);
});

// ── The chat card ──────────────────────────────────────────────────────

const MESSAGE = { id: "m1", threadId: "thread-a", turnId: null, projectId: null };

function renderCard(
  rpc: Partial<Handlers>,
  attributes: Record<string, string> = { key: encodeURIComponent(KEY), revision: HEAD },
) {
  return renderSlot(
    { component: ChangeDirective },
    { attributes, source: "", message: MESSAGE, openWorkspaceFile: null },
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      rpc: {
        checksForChange: ({ keys }) =>
          Object.fromEntries(keys.map((key) => [key, { read: null, problem: null }])),
        ...reviewServer([finding(1, 2)]).handlers,
        ...rpc,
      } as Handlers,
    },
  );
}

test("the chat card reserves its space while the change loads", async () => {
  const slot = renderCard({ changeDetail: () => new Promise(() => {}) });
  expect(await slot.findByTestId("sc-card-loading")).toBeTruthy();
});

test("the chat card says when it could not read the change, and tries again", async () => {
  let calls = 0;
  const slot = renderCard({
    changeDetail: () => {
      calls += 1;
      throw new Error("The server is unreachable.");
    },
  });
  const failed = await slot.findByTestId("sc-card-failed", {}, { timeout: 4000 });
  expect(failed.textContent).toContain("The server is unreachable.");
  const before = calls;
  fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(calls).toBeGreaterThan(before));
});

test("the chat card keeps the last read while offline and says so", async () => {
  const slot = renderCard({
    changeDetail: ({ keys }) => Object.fromEntries(keys.map((key) => [key, DETAIL])),
  });
  expect((await slot.findByTestId("sc-card")).textContent).toContain("A local change");
  expect(slot.queryByTestId("sc-card-stale")).toBeNull();
  await slot.setRealtimeConnectionState("reconnecting");
  expect((await slot.findByTestId("sc-card-stale")).textContent).toContain("Offline.");
  expect(slot.getByTestId("sc-card").textContent).toContain("Finding 1");
});

test("the chat card says when the change moved past the revision it was shared at", async () => {
  const slot = renderCard(
    { changeDetail: ({ keys }) => Object.fromEntries(keys.map((key) => [key, DETAIL])) },
    { key: encodeURIComponent(KEY), revision: "abc1234" },
  );
  expect((await slot.findByTestId("sc-card-moved")).textContent).toContain("abc1234");
});

test("the chat card refuses a key it cannot read", () => {
  const slot = renderCard({}, { key: "%E0%A4%A" });
  expect(slot.getByTestId("sc-card-invalid")).toBeTruthy();
});

test("Escape with the tray open closes the tray and goes no further", async () => {
  const server = reviewServer([finding(1, 2)]);
  const slot = render(server.handlers);
  const rail = await slot.findByTestId("sc-rail-review");
  fireEvent.click(within(rail).getAllByTestId("sc-review-check")[0]!);
  const send = slot.getByTestId("sc-send");
  fireEvent.click(send);
  const tray = await slot.findByTestId("sc-tray");
  let reachedPage = 0;
  const onPage = (event: KeyboardEvent) => {
    if (event.key === "Escape") reachedPage += 1;
  };
  document.addEventListener("keydown", onPage);
  try {
    fireEvent.keyDown(send, { key: "Escape" });
  } finally {
    document.removeEventListener("keydown", onPage);
  }
  expect(send.getAttribute("aria-expanded")).toBe("false");
  expect(tray.className).toContain("hidden");
  expect(reachedPage).toBe(0);
});

test("two checks one after another both stay checked, before and after the server answers", async () => {
  const server = reviewServer([finding(1, 2), finding(2, 3)]);
  const slot = render(server.handlers);
  const boxes = () => within(slot.getByTestId("thread-tab")).getAllByTestId("sc-finding-check");
  await waitFor(() => expect(boxes()).toHaveLength(2));
  fireEvent.click(boxes()[0]!);
  await waitFor(() => expect(server.state.selected).toHaveLength(1));
  await slot.experimental_invalidateRpc([reviewTag(KEY)]);
  fireEvent.click(boxes()[1]!);
  expect(boxes().map(checked)).toEqual(["true", "true"]);
  await waitFor(() => expect(server.state.selected).toHaveLength(2));
  await slot.experimental_invalidateRpc([reviewTag(KEY)]);
  await waitFor(() => expect(boxes().map(checked)).toEqual(["true", "true"]));
});
