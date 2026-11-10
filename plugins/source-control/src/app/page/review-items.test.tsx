// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { changeKeySchema, reviewTag, type ChangeKey } from "../../core/ids.ts";
import type { ChangeReview, Draft, DraftInput, ReviewItem } from "../../core/items.ts";
import { reviewPath, type ChangeDetail, type ChangeRow } from "../../core/review.ts";
import { sourceControlContract } from "../../contract/rpc.ts";
import { FindingsCard } from "../findings-card.tsx";
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

/** The server's review store, as the handlers below keep it. */
function reviewServer(items: ReviewItem[]) {
  const state: ChangeReview = {
    items,
    drafts: [],
    selected: [],
    runs: [],
    forge: { at: null, problem: null },
  };
  const saved: DraftInput[] = [];
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
  };
  return { state, saved, handlers };
}

type Handlers = PluginRpcTestHandlers<typeof sourceControlContract>;

/** The review page and the thread tab's card, both on screen, as when the page is split beside a thread. */
function Both() {
  return (
    <>
      <ReviewPanel subPath={reviewPath({ key: KEY })} />
      <div data-testid="thread-tab">
        <FindingsCard changeKey={KEY} visible />
      </div>
    </>
  );
}

function render(review: Partial<Handlers>) {
  return renderSlot(
    { component: Both },
    {},
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      rpc: {
        changeDetail: ({ keys }) => Object.fromEntries(keys.map((key) => [key, DETAIL])),
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
  const server = reviewServer([finding(1, 2), finding(2, 4)]);
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
  const server = reviewServer([finding(1, 2)]);
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
    replyTo: finding(1, 2).id,
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
