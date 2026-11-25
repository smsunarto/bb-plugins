// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import MarkdownIt from "markdown-it";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { EMPTY_GUIDE_VIEW, type Guide, type GuideView } from "../../core/guide.ts";
import { changeKeySchema, guideTag, type ChangeKey } from "../../core/ids.ts";
import type { ChangeReview, ReviewItem } from "../../core/items.ts";
import {
  reviewPath,
  type ChangeDetail,
  type ChangeFile,
  type ChangeRow,
} from "../../core/review.ts";
import { sourceControlContract } from "../../contract/rpc.ts";
import { FindingsCard } from "../findings-card.tsx";
import { resetPendingViewed } from "../guide-data.ts";
import { resetPendingWrites } from "../review-data.ts";
import { ReviewPanel } from "../review-entry.tsx";
import { resetNavStores } from "./sources.ts";
import { resetPatchStores } from "./patches.ts";

const sheet = CSSStyleSheet.prototype as unknown as { replaceSync?: (text: string) => void };
sheet.replaceSync ??= () => {};
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
// jsdom has no scrolling; an outline pick scrolls the column.
Element.prototype.scrollTo ??= () => {};

type Handlers = PluginRpcTestHandlers<typeof sourceControlContract>;

const KEY: ChangeKey = changeKeySchema.parse("local:host-a:/work/.git:scott/guided");
const HEAD = "c0ffee1";
const blob = (n: number) => String(n).repeat(40);

const ROW: ChangeRow = {
  key: KEY,
  repo: "smsunarto/bb-plugins",
  title: "Route gh through the checkout host",
  branch: "scott/guided",
  baseRef: "main",
  number: 482,
  url: null,
  author: "smsunarto",
  state: "draft",
  mine: true,
  asked: false,
  stack: null,
  hostId: "host-a",
  line: "Draft",
  chips: [],
  sort: 6,
  updatedAt: new Date().toISOString(),
};

function detail(head = HEAD): ChangeDetail {
  return {
    state: "change",
    row: ROW,
    head,
    files: 3,
    additions: 6,
    deletions: 3,
    revision: { head, base: "b0", source: { kind: "host", hostId: "host-a", path: "/work" } },
    stack: null,
    canMarkReady: false,
    ship: [],
    status: { label: "Draft", tone: "draft", number: 482, noPullRequest: false },
    problem: null,
    at: Date.now(),
  };
}

function file(path: string, n: number | undefined): ChangeFile {
  return {
    path,
    kind: "modified",
    previousPath: null,
    additions: 2,
    deletions: 1,
    binary: false,
    ...(n === undefined ? {} : { blob: blob(n) }),
  };
}

const FILES = [file("src/a.ts", 1), file("src/b.ts", 2), file("src/c.ts", 3)];

const patchOf = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,4 @@",
    " one",
    "-two",
    "+TWO",
    "+three",
    " four",
    "",
  ].join("\n");

function comment(path: string): ReviewItem {
  return {
    id: `gh:${path}`,
    origin: { kind: "forge", author: "mira", bot: false, slopcop: false },
    priority: null,
    title: null,
    body: "Why here?",
    anchor: { path, line: 2, startLine: null, side: "RIGHT", head: HEAD },
    state: "open",
    url: null,
    createdAt: new Date().toISOString(),
    replies: [],
  };
}

function review(items: ReviewItem[] = []): ChangeReview {
  return {
    items,
    drafts: [],
    selected: [],
    runs: [],
    forge: { at: null, problem: null },
    batches: [],
    tray: { destination: "agent", target: null },
    viewer: null,
  };
}

/** c first, then b, then a: the reverse of the derived order. */
function guideFor(revision: string): Guide {
  return {
    changeKey: KEY,
    revision,
    summary: "The risk is in the host client.",
    groups: [
      {
        id: "client",
        title: "Move the gh client to the host entry",
        intro: "Read c.ts first.",
        files: [
          { path: "src/c.ts", blob: blob(3), note: "The client itself" },
          { path: "src/b.ts", blob: blob(2), note: null },
        ],
      },
      {
        id: "rest",
        title: "Callers",
        intro: "",
        files: [{ path: "src/a.ts", blob: blob(1), note: null }],
      },
    ],
  };
}

type Server = {
  guide: GuideView;
  files: ChangeFile[];
  head: string;
  items: ReviewItem[];
  description?: string;
  guideRead?: Handlers["guideForChange"];
};

function handlers(server: Server): Partial<Handlers> {
  return {
    changeDetail: ({ keys }) => Object.fromEntries(keys.map((key) => [key, detail(server.head)])),
    checksForChange: ({ keys }) =>
      Object.fromEntries(keys.map((key) => [key, { read: null, problem: null }])),
    changeFiles: () => ({ ok: true as const, files: server.files, more: false }),
    changePatches: ({ paths }) => ({
      ok: true as const,
      value: {
        files: paths.map((path) => ({
          path,
          kind: "modified" as const,
          previousPath: null,
          patch: patchOf(path),
          truncated: false,
        })),
      },
    }),
    reviewForChange: ({ keys }) =>
      Object.fromEntries(keys.map((key) => [key, review(server.items)])),
    guideForChange:
      server.guideRead ??
      (({ keys }) => Object.fromEntries(keys.map((key) => [key, structuredClone(server.guide)]))),
    openGuide: () => server.guide,
    rewriteGuide: () => {
      server.guide = { ...server.guide, state: "running", phase: "writing", problem: null };
      return server.guide;
    },
    setViewed: ({ path, blob: at, viewed }) => {
      const rest = server.guide.viewed.filter((mark) => mark.path !== path);
      server.guide = { ...server.guide, viewed: viewed ? [...rest, { path, blob: at }] : rest };
      return { ok: true as const };
    },
    changeConversation: () => ({
      ok: true as const,
      readAt: Date.now(),
      stale: null,
      description: {
        author: { login: "scott", avatarUrl: null },
        body: server.description ?? "",
        createdAt: new Date().toISOString(),
        url: "https://github.com/o/r/pull/482",
      },
      items: [],
    }),
    agentTargets: () => ({ targets: [] }),
    startReview: () => ({ ok: true as const, threadId: "thread-r", reused: false }),
  };
}

function render(server: Server, component: () => React.ReactNode = Guided) {
  return renderSlot(
    { component },
    {},
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      rpc: handlers(server) as Handlers,
    },
  );
}

function Guided() {
  return <ReviewPanel subPath={reviewPath({ key: KEY, tab: "overview" })} />;
}

const order = (root: HTMLElement) =>
  within(root)
    .getAllByTestId("sc-file-card")
    .map((card) => card.getAttribute("data-path"));

const card = (root: HTMLElement, path: string) =>
  within(root)
    .getAllByTestId("sc-file-card")
    .find((element) => element.getAttribute("data-path") === path)!;

const server = (extra: Partial<Server> = {}): Server => ({
  guide: { ...EMPTY_GUIDE_VIEW, state: "running", phase: "writing", revision: HEAD },
  files: FILES,
  head: HEAD,
  items: [],
  ...extra,
});

const width = window.innerWidth;
beforeEach(() => {
  localStorage.clear();
  resetNavStores();
  resetPendingWrites();
  resetPendingViewed();
  resetPatchStores();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
});

test("the derived order paints while the guide read hangs", async () => {
  const slot = render(server({ guideRead: () => new Promise(() => {}) }));
  const cards = await slot.findByTestId("sc-guided-cards");
  await waitFor(() => expect(order(cards)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]));
  expect(slot.queryByTestId("sc-guide-summary")).toBeNull();
  expect(slot.getByTestId("sc-tab-overview").getAttribute("aria-selected")).toBe("true");
});

test("the Overview opens on the pull request's description, above the guide", async () => {
  const slot = render(server({ description: "Fixes the helmet overlap at 4:3." }));
  const description = await slot.findByTestId("sc-description");
  expect(description.textContent).toContain("Fixes the helmet overlap at 4:3.");
  expect(description.textContent).toContain("scott");
  const cards = await slot.findByTestId("sc-guided-cards");
  expect(
    description.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(slot.getByTestId("sc-tab-overview").textContent).toContain("Overview");
});

test("a long description starts clipped and opens in full", async () => {
  const slot = render(server({ description: "word ".repeat(400) }));
  const description = await slot.findByTestId("sc-description");
  const toggle = within(description).getByRole("button", { name: "Show full description" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(
    within(description).getByRole("button", { name: "Show less" }).getAttribute("aria-expanded"),
  ).toBe("true");
});

test("the description's GitHub images load through the plugin's image route; others keep their URL", async () => {
  const github = changeKeySchema.parse("gh:o/r:o:scott/guided");
  const upload = "https://github.com/user-attachments/assets/0993b262-b0ae-4631-b40a-65c93ae1420c";
  const committed = "https://github.com/o/r/blob/scott/guided/docs/Screenshot_(1).png?raw=true";
  const badge = "https://img.shields.io/badge/x-y-green";
  const slot = render(
    server({
      description: [
        `![shot](${upload})`,
        `<img width="300" alt="html" src="${upload}">`,
        `![committed](${committed})`,
        `![badge](${badge})`,
        "```md",
        `![in code](${upload})`,
        "```",
      ].join("\n\n"),
    }),
    () => <ReviewPanel subPath={reviewPath({ key: github, tab: "overview" })} />,
  );
  const description = await slot.findByTestId("sc-description");
  // bb's test Markdown prints its content; render it as Markdown to see the images a reader gets.
  const page = document.createElement("div");
  page.innerHTML = new MarkdownIt({ html: true }).render(
    within(description).getByTestId("bb-markdown").textContent ?? "",
  );
  const images = [...page.querySelectorAll("img")].map((image) => {
    const url = new URL(image.getAttribute("src")!);
    return url.pathname === "/api/v1/plugins/source-control/http/pr-image"
      ? { routed: url.searchParams.get("src"), change: url.searchParams.get("change") }
      : { direct: url.href };
  });
  expect(images).toEqual([
    { routed: upload, change: github },
    { routed: upload, change: github },
    { routed: committed, change: github },
    { direct: badge },
  ]);
  expect(page.querySelector("code")?.textContent).toContain(`![in code](${upload})`);
});

test("an empty description says so", async () => {
  const slot = render(server());
  const description = await slot.findByTestId("sc-description");
  expect(description.textContent).toContain("No description provided.");
});

test("the guide landing reorders cards without remounting: focus, composer text and collapsed state stay", async () => {
  const state = server({ items: [comment("src/b.ts")] });
  const slot = render(state);
  const cards = await slot.findByTestId("sc-guided-cards");
  await waitFor(() => expect(order(cards)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]));
  expect(slot.getByTestId("sc-guide-status").textContent).toContain("bb is writing the guide.");

  // Collapse a.ts, and start a reply on b.ts's comment.
  fireEvent.click(within(card(cards, "src/a.ts")).getByRole("button", { expanded: true }));
  expect(card(cards, "src/a.ts").getAttribute("data-open")).toBe("false");
  const b = card(cards, "src/b.ts");
  fireEvent.click(await within(b).findByTestId("sc-reply"));
  const box = (await within(b).findByRole("textbox", { name: "Reply" })) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "Key it by account" } });
  act(() => box.focus());

  state.guide = { ...state.guide, state: "done", phase: "done", guide: guideFor(HEAD) };
  await slot.experimental_invalidateRpc([guideTag(KEY)]);
  await waitFor(() => expect(order(cards)).toEqual(["src/c.ts", "src/b.ts", "src/a.ts"]));

  expect(card(cards, "src/b.ts")).toBe(b);
  expect(within(b).getByRole("textbox", { name: "Reply" })).toBe(box);
  expect(box.value).toBe("Key it by account");
  expect(document.activeElement).toBe(box);
  expect(card(cards, "src/a.ts").getAttribute("data-open")).toBe("false");
  expect(slot.getByTestId("sc-guide-summary").textContent).toContain(
    "The risk is in the host client.",
  );
  expect(slot.getAllByTestId("sc-file-note")[0]!.textContent).toBe("The client itself");
  expect(slot.queryByTestId("sc-guide-status")).toBeNull();
});

test("viewed marks count only at the blob they were made on, and unknown blobs cannot be marked", async () => {
  // a.ts is unchanged since its mark; b.ts changed after it; c.ts has no known blob.
  const state = server({
    files: [file("src/a.ts", 1), file("src/b.ts", 7), file("src/c.ts", undefined)],
    guide: {
      ...EMPTY_GUIDE_VIEW,
      state: "done",
      phase: "done",
      revision: "0dd0dd",
      guide: guideFor("0dd0dd"),
      viewed: [
        { path: "src/a.ts", blob: blob(1) },
        { path: "src/b.ts", blob: blob(2) },
      ],
    },
  });
  const slot = render(state);
  const cards = await slot.findByTestId("sc-guided-cards");
  await waitFor(() => expect(card(cards, "src/a.ts").getAttribute("data-viewed")).toBe("true"));
  expect(card(cards, "src/b.ts").getAttribute("data-viewed")).toBe("false");
  expect(within(card(cards, "src/c.ts")).queryByTestId("sc-viewed-check")).toBeNull();
  expect(slot.getByTestId("sc-viewed-progress").textContent).toContain("1 of 3 viewed");
  // b.ts and c.ts changed since the guide: they leave its groups.
  expect(
    slot.getAllByTestId("sc-guide-group").map((group) => group.getAttribute("data-group")),
  ).toEqual(["rest", "changed-since-guide"]);

  // Marking b.ts writes its current blob, ticks at once and collapses the card.
  fireEvent.click(within(card(cards, "src/b.ts")).getByTestId("sc-viewed-check"));
  expect(card(cards, "src/b.ts").getAttribute("data-viewed")).toBe("true");
  expect(card(cards, "src/b.ts").getAttribute("data-open")).toBe("false");
  await waitFor(() =>
    expect(state.guide.viewed).toContainEqual({ path: "src/b.ts", blob: blob(7) }),
  );
  expect(
    slot.inspection.rpcCalls
      .filter((call) => call.method === "setViewed")
      .map((call) => call.input),
  ).toEqual([{ key: KEY, path: "src/b.ts", blob: blob(7), viewed: true }]);
  await waitFor(() =>
    expect(slot.getByTestId("sc-viewed-progress").textContent).toContain("2 of 3 viewed"),
  );
});

test("openGuide runs once when the review page opens a Change, and never from the thread tab's card", async () => {
  const card = render(server(), () => (
    <FindingsCard changeKey={KEY} threadId="thread-a" head={HEAD} visible />
  ));
  await act(async () => {});
  expect(card.inspection.rpcCalls.some((call) => call.method === "openGuide")).toBe(false);
  cleanup();

  const page = render(server());
  await page.findByTestId("sc-guided-cards");
  await page.experimental_invalidateRpc([guideTag(KEY)]);
  await act(async () => {});
  expect(page.inspection.rpcCalls.filter((call) => call.method === "openGuide")).toEqual([
    { method: "openGuide", input: { key: KEY } },
  ]);
});

function phone() {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
}

test("the phone's guided screen keeps the review bar and its clearance while the guide is written", async () => {
  phone();
  vi.stubGlobal(
    "ResizeObserver",
    class extends ResizeObserver {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        super(callback);
        this.callback = callback;
      }
      override observe(target: Element, options?: ResizeObserverOptions) {
        if (options?.box === "border-box") {
          const size = { blockSize: 116, inlineSize: 390 };
          this.callback(
            [
              {
                target,
                borderBoxSize: [size],
                contentBoxSize: [size],
                devicePixelContentBoxSize: [size],
                contentRect: new DOMRect(0, 0, 390, 116),
              },
            ],
            this,
          );
        }
      }
    },
  );
  const slot = render(server({ items: [comment("src/b.ts")] }));
  await slot.findByTestId("sc-phone-header");
  const status = await slot.findByTestId("sc-guide-status");
  expect(status.getAttribute("data-phase")).toBe("writing");
  expect(status.textContent).toContain("Files are in path order until then.");
  const guided = within(slot.getByTestId("sc-guided"));
  const column = guided.getByTestId("sc-diff-column");
  const bar = within(column).getByTestId("sc-review-bar");
  expect(column.style.getPropertyValue("--sc-review-bar-space")).toBe("116px");
  expect(column.classList.contains("scroll-pb-[var(--sc-review-bar-space,0px)]")).toBe(true);
  expect(column.firstElementChild?.classList.contains("pb-[var(--sc-review-bar-space,0px)]")).toBe(
    true,
  );
  expect(within(bar).getByTestId("sc-send")).toBeTruthy();
  await waitFor(() =>
    expect(within(bar).getByTestId("sc-review-bar-position").textContent).toBe("1 item"),
  );
  fireEvent.click(within(bar).getByRole("button", { name: "Next item" }));
  expect(within(bar).getByTestId("sc-review-bar-position").textContent).toBe("1 of 1");
});

test("on a phone a failed guide names why and Try again asks for a rewrite", async () => {
  phone();
  const state = server({
    guide: {
      ...EMPTY_GUIDE_VIEW,
      state: "failed",
      phase: "failed",
      problem: { kind: "failed", site: "bb", detail: "The guide run stopped." },
    },
  });
  const slot = render(state);
  const status = await slot.findByTestId("sc-guide-status");
  expect(status.textContent).toContain("bb couldn't write the guide. The guide run stopped.");
  fireEvent.click(within(status).getByTestId("sc-guide-action"));
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.some((call) => call.method === "rewriteGuide")).toBe(true),
  );
});

test("on a phone a guide for an earlier head shows what changed since and offers Regenerate guide", async () => {
  phone();
  const state = server({
    files: [file("src/a.ts", 1), file("src/b.ts", 9), file("src/c.ts", 3)],
    guide: {
      ...EMPTY_GUIDE_VIEW,
      state: "done",
      phase: "done",
      revision: "0dd0dd",
      guide: guideFor("0dd0dd"),
    },
  });
  const slot = render(state);
  const status = await slot.findByTestId("sc-guide-status");
  expect(within(status).getByRole("heading").textContent).toBe("This guide is out of date");
  expect(within(status).getByTestId("sc-guide-action").textContent).toBe("Regenerate guide");
  const groups = slot.getAllByTestId("sc-guide-group");
  expect(groups.map((group) => group.getAttribute("data-group"))).toEqual([
    "client",
    "rest",
    "changed-since-guide",
  ]);
  expect(groups[0]!.textContent).toContain("1 of 3 · read this first");
  expect(groups[2]!.textContent).toContain("Changed since the guide");
  expect(status.textContent).toContain("Files changed since then are listed at the end");
  fireEvent.click(within(status).getByTestId("sc-guide-action"));
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.some((call) => call.method === "rewriteGuide")).toBe(true),
  );
});

test("a guide for an earlier head whose files are all unchanged still offers Regenerate guide, without pointing at changed files", async () => {
  const state = server({
    files: FILES,
    guide: {
      ...EMPTY_GUIDE_VIEW,
      state: "done",
      phase: "done",
      revision: "0dd0dd",
      guide: guideFor("0dd0dd"),
    },
  });
  const slot = render(state);
  const status = await slot.findByTestId("sc-guide-status");
  await waitFor(() =>
    expect(
      slot.getAllByTestId("sc-guide-group").map((group) => group.getAttribute("data-group")),
    ).toEqual(["client", "rest"]),
  );
  expect(within(status).getByRole("heading").textContent).toBe("This guide is out of date");
  expect(status.textContent).toContain("It was written for an earlier commit.");
  expect(status.textContent).not.toContain("listed at the end");
  expect(within(status).getByTestId("sc-guide-action").textContent).toBe("Regenerate guide");
});

test("pressing an outline section lists its files under it, and a file there opens it in the column", async () => {
  const state = server({
    guide: {
      ...EMPTY_GUIDE_VIEW,
      state: "done",
      phase: "done",
      revision: HEAD,
      guide: guideFor(HEAD),
    },
  });
  const slot = render(state);
  const outline = await slot.findByTestId("sc-guide-outline");
  const row = async (id: string) =>
    await waitFor(() => {
      const found = within(outline)
        .getAllByTestId("sc-outline-row")
        .find((element) => element.getAttribute("data-group") === id);
      expect(found).toBeDefined();
      return found!;
    });
  const listed = () =>
    within(outline)
      .queryAllByTestId("sc-outline-file")
      .map((element) => element.getAttribute("data-path"));

  const client = await row("client");
  expect(client.getAttribute("aria-expanded")).toBe("false");
  expect(listed()).toEqual([]);

  fireEvent.click(client);
  expect(client.getAttribute("aria-expanded")).toBe("true");
  expect(listed()).toEqual(["src/c.ts", "src/b.ts"]);

  const b = within(outline)
    .getAllByTestId("sc-outline-file")
    .find((element) => element.getAttribute("data-path") === "src/b.ts")!;
  fireEvent.click(b);
  await waitFor(() => expect(b.getAttribute("aria-current")).toBe("location"));
  expect(card(slot.getByTestId("sc-guided-cards"), "src/b.ts").getAttribute("data-open")).toBe(
    "true",
  );

  // One section at a time.
  fireEvent.click(await row("rest"));
  expect(listed()).toEqual(["src/a.ts"]);
  expect(client.getAttribute("aria-expanded")).toBe("false");

  // Pressing the open section folds its files away.
  fireEvent.click(await row("rest"));
  expect(listed()).toEqual([]);
});
