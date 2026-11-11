// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import { changeKeySchema, type ChangeKey } from "../../core/ids.ts";
import {
  parseReviewPath,
  reviewPath,
  type ChangeDetail,
  type ChangeFile,
  type ChangeRow,
  type PageSources,
  type ReviewRevision,
  type SourceRows,
} from "../../core/review.ts";
import { sourceControlContract } from "../../contract/rpc.ts";
import { shipPath } from "../../core/status.ts";
import { ReviewPanel as ReviewPage, ReviewSidebar as ChangesSidebar } from "../review-entry.tsx";
import { resetNavStores } from "./sources.ts";
import { resetPatchStores } from "./patches.ts";
import { OVERSCAN } from "./use-window.ts";

const key = (branch: string, repo = "smsunarto/bb-plugins") =>
  changeKeySchema.parse(`gh:${repo}:smsunarto:${branch}`);

function row(branch: string, overrides: Partial<ChangeRow> = {}): ChangeRow {
  return {
    key: key(branch),
    repo: "smsunarto/bb-plugins",
    title: `Title of ${branch}`,
    branch,
    baseRef: "main",
    number: null,
    url: null,
    author: "smsunarto",
    state: "open",
    mine: true,
    asked: false,
    stack: null,
    hostId: null,
    line: "Review requested",
    chips: [],
    sort: 6,
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...overrides,
  };
}

const read = (rows: ChangeRow[]): SourceRows => ({ read: { rows, at: Date.now() }, problem: null });
const PENDING: SourceRows = { read: null, problem: null };

const SOURCES: PageSources = {
  hosts: [
    { hostId: "host-a", name: "studio-mac" },
    { hostId: "host-b", name: "build-linux" },
  ],
  accounts: [{ login: "smsunarto", active: true }],
};

const revision = (head: string): ReviewRevision => ({
  head,
  base: "base0000",
  source: { kind: "forge", number: 1 },
});

function detail(
  r: ChangeRow,
  overrides: Partial<Extract<ChangeDetail, { state: "change" }>> = {},
): ChangeDetail {
  return {
    state: "change",
    row: r,
    head: `${r.branch}-head`,
    files: 2,
    additions: 10,
    deletions: 2,
    revision: revision(`${r.branch}-head`),
    stack: null,
    canMarkReady: false,
    ship: [],
    status: { label: "Draft", tone: "draft", number: r.number, noPullRequest: false },
    problem: null,
    at: Date.now(),
    ...overrides,
  };
}

const file = (path: string): ChangeFile => ({
  path,
  kind: "modified",
  previousPath: null,
  additions: 3,
  deletions: 1,
  binary: false,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

const emptyPatches = (paths: string[]) => ({
  ok: true as const,
  value: {
    files: paths.map((path) => ({
      path,
      kind: "modified" as const,
      previousPath: null,
      patch: "",
      truncated: false,
    })),
  },
});

/** The page and its sidebar, as bb mounts them for one route, with a subPath tests can move. */
let subPath = "";
const pathListeners = new Set<() => void>();
function moveTo(next: string) {
  subPath = next;
  for (const listener of pathListeners) listener();
}
function Route() {
  const current = useSyncExternalStore(
    (listener) => {
      pathListeners.add(listener);
      return () => pathListeners.delete(listener);
    },
    () => subPath,
  );
  return (
    <>
      <ChangesSidebar subPath={current} />
      <ReviewPage subPath={current} />
    </>
  );
}

type Handlers = PluginRpcTestHandlers<typeof sourceControlContract>;

function render(rpc: Partial<Handlers>, start = "") {
  subPath = start;
  return renderSlot(
    { component: Route },
    {},
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      rpc: {
        pageSources: () => SOURCES,
        inbox: ({ keys }) => Object.fromEntries(keys.map((login) => [login, read([])])),
        hostChanges: ({ keys }) => Object.fromEntries(keys.map((id) => [id, read([])])),
        changeDetail: ({ keys }) =>
          Object.fromEntries(keys.map((k) => [k, { state: "missing", problem: null }])),
        checksForChange: ({ keys }) =>
          Object.fromEntries(keys.map((k) => [k, { read: null, problem: null }])),
        changeFiles: () => ({ ok: true as const, files: [], more: false }),
        changePatches: ({ paths }) => emptyPatches(paths),
        changeCommits: () => ({ ok: true as const, commits: [], more: false }),
        ...rpc,
      } as Handlers,
    },
  );
}

const navRows = (slot: ReturnType<typeof render>) =>
  slot.queryAllByTestId("sc-nav-row").map((element) => element.getAttribute("data-key"));

beforeEach(() => {
  localStorage.clear();
  resetNavStores();
  resetPatchStores();
});
afterEach(cleanup);

test("the app registers the review page as a nav panel with a sidebar and a badge", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const panel = app.navPanels.find((registration) => registration.id === "source-control");
  expect(panel).toBeTruthy();
  expect(panel!.path).toBe("source-control");
});

test("with one host's read hung, the selected change is usable and that host stays pending", async () => {
  const selected = row("scott/forge-host", {
    number: 482,
    title: "Route gh through the checkout host",
  });
  const local = row("scott/change-view", {
    hostId: "host-a",
    state: "local",
    title: "Change view shell",
  });
  const slot = render(
    {
      inbox: () => ({ smsunarto: read([selected]) }),
      // studio-mac answers from its last read; build-linux has never been read.
      hostChanges: ({ keys }) =>
        Object.fromEntries(keys.map((id) => [id, id === "host-a" ? read([local]) : PENDING])),
      changeDetail: ({ keys }) => Object.fromEntries(keys.map((k) => [k, detail(selected)])),
      changeFiles: () => ({ ok: true as const, files: [file("src/a.ts")], more: false }),
    },
    reviewPath({ key: selected.key }),
  );
  expect(await slot.findByTestId("sc-review-title")).toHaveProperty(
    "textContent",
    "Route gh through the checkout host",
  );
  await waitFor(() =>
    expect(navRows(slot)).toEqual(expect.arrayContaining([selected.key, local.key])),
  );
  const pending = slot.getAllByTestId("sc-source-pending");
  expect(pending.map((element) => element.getAttribute("data-source"))).toEqual(["host-b"]);
  expect(pending[0]!.textContent).toContain("Still reading build-linux");
  // The selected change's files are usable while build-linux reads.
  expect(await slot.findAllByTestId("sc-file-card")).toHaveLength(1);
  // Stop drops build-linux from the watched keys.
  fireEvent.click(slot.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(slot.queryAllByTestId("sc-source-pending")).toHaveLength(0));
  expect(slot.getByText("Not reading build-linux")).toBeTruthy();
});

test("a hostChanges call that never answers blocks neither the inbox rows nor the page", async () => {
  const selected = row("scott/forge-host", { number: 482, title: "Selected change" });
  const slot = render(
    {
      inbox: () => ({ smsunarto: read([selected]) }),
      hostChanges: () => new Promise(() => {}),
      changeDetail: ({ keys }) => Object.fromEntries(keys.map((k) => [k, detail(selected)])),
    },
    reviewPath({ key: selected.key }),
  );
  expect((await slot.findByTestId("sc-review-title")).textContent).toBe("Selected change");
  await waitFor(() => expect(navRows(slot)).toEqual([selected.key]));
  expect(slot.getAllByTestId("sc-source-pending").map((element) => element.textContent)).toEqual([
    "Still reading studio-macStop",
    "Still reading build-linuxStop",
  ]);
});

test("a Change that conflicts with its base says so in the header and on the ship path", async () => {
  const conflicting = row("scott/forge-host", {
    number: 482,
    chips: [{ id: "conflicts", label: "Conflicts", tone: "error", icon: "cross" }],
  });
  const ship = shipPath({
    key: conflicting.key,
    branch: null,
    onGitHub: true,
    uncommitted: 0,
    conflicted: false,
    findings: 0,
    pullRequest: {
      number: 482,
      url: "https://github.com/smsunarto/bb-plugins/pull/482",
      title: "t",
      state: "open",
      isDraft: false,
      headRefOid: "c0ffee",
      baseRef: "main",
      reviewDecision: null,
      approvals: 0,
      mergeable: "conflicting",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      commits: 1,
      checks: { passed: 0, failed: 0, pending: 0 },
    },
  });
  const slot = render(
    {
      inbox: () => ({ smsunarto: read([conflicting]) }),
      changeDetail: ({ keys }) =>
        Object.fromEntries(keys.map((k) => [k, detail(conflicting, { ship })])),
    },
    reviewPath({ key: conflicting.key }),
  );
  expect((await slot.findByTestId("sc-review-conflicts")).textContent).toBe("Conflicts with main");
  expect(slot.getByTestId("sc-review-page").textContent).toContain("MergedConflicts with main");
});

test("a late changeDetail answer for A never draws in B's pane", async () => {
  const a = row("scott/a", { number: 1, title: "Change A" });
  const b = row("scott/b", { number: 2, title: "Change B" });
  const late = deferred<Record<string, ChangeDetail>>();
  const slot = render(
    {
      inbox: () => ({ smsunarto: read([a, b]) }),
      changeDetail: ({ keys }) =>
        keys.includes(a.key) ? late.promise : Object.fromEntries(keys.map((k) => [k, detail(b)])),
    },
    reviewPath({ key: a.key }),
  );
  expect(await slot.findByTestId("sc-review-loading")).toBeTruthy();
  act(() => moveTo(reviewPath({ key: b.key })));
  // bb holds one read per keyed method: B is read once A's call settles.
  await act(async () => {
    late.resolve({ [a.key]: detail(a) });
    await late.promise;
  });
  expect((await slot.findByTestId("sc-review-title")).textContent).toBe("Change B");
  expect(slot.getByTestId("sc-review-page").textContent).not.toContain("Change A");
});

test("late patches for A never draw in B's pane", async () => {
  const a = row("scott/a", { number: 1, title: "Change A" });
  const b = row("scott/b", { number: 2, title: "Change B" });
  const late = deferred<ReturnType<typeof emptyPatches>>();
  const slot = render(
    {
      inbox: () => ({ smsunarto: read([a, b]) }),
      changeDetail: ({ keys }) =>
        Object.fromEntries(keys.map((k) => [k, detail(k === a.key ? a : b)])),
      // Both changes touch the same path, so only the revision tells their patches apart.
      changeFiles: () => ({ ok: true as const, files: [file("src/shared.ts")], more: false }),
      changePatches: ({ key: which, paths }) =>
        which === a.key ? late.promise : emptyPatches(paths),
    },
    reviewPath({ key: a.key }),
  );
  expect(await slot.findByTestId("sc-patch-loading")).toBeTruthy();
  act(() => moveTo(reviewPath({ key: b.key })));
  expect(await slot.findByTestId("sc-patch-empty")).toBeTruthy();
  expect(slot.getByTestId("sc-review-title").textContent).toBe("Change B");
  await act(async () => {
    late.resolve({
      ok: true,
      value: {
        files: [
          {
            path: "src/shared.ts",
            kind: "modified",
            previousPath: null,
            patch: "",
            truncated: true,
          },
        ],
      },
    });
    await late.promise;
  });
  // A's answer said "too large"; B's pane still shows B's own patch.
  expect(slot.getByTestId("sc-patch-empty").textContent).toContain("No text to show");
  expect(slot.getByTestId("sc-review-title").textContent).toBe("Change B");
  const patchCalls = slot.inspection.rpcCalls.filter((call) => call.method === "changePatches");
  expect(patchCalls.map((call) => (call.input as { key: string }).key)).toEqual([a.key, b.key]);
});

test("filters count every source's rows once and show only their own", async () => {
  const both = row("scott/both", { asked: false, mine: true });
  const slot = render({
    inbox: () => ({
      smsunarto: read([
        both,
        row("mira/asked", { mine: false, asked: true, author: "mira" }),
        row("jonas/other", { mine: false }),
      ]),
    }),
    // The same Change from a checkout counts once.
    hostChanges: ({ keys }) =>
      Object.fromEntries(
        keys.map((id) => [id, read(id === "host-a" ? [{ ...both, hostId: "host-a" }] : [])]),
      ),
  });
  await waitFor(() => expect(navRows(slot)).toHaveLength(3));
  expect(slot.getByTestId("sc-filter-all").textContent).toBe("All 3");
  expect(slot.getByTestId("sc-filter-mine").textContent).toBe("Mine 1");
  expect(slot.getByTestId("sc-filter-asked").textContent).toBe("Asked 1");
  fireEvent.click(slot.getByTestId("sc-filter-asked"));
  await waitFor(() => expect(navRows(slot)).toEqual([key("mira/asked")]));
});

test("a stack groups its branches top first under one header", async () => {
  const stack = (branch: string, position: number) =>
    row(branch, {
      hostId: "host-a",
      state: "local",
      stack: { id: "host-a:/w/.git:bottom", position, size: 3 },
    });
  const slot = render({
    hostChanges: ({ keys }) =>
      Object.fromEntries(
        keys.map((id) => [
          id,
          read(id === "host-a" ? [stack("bottom", 1), stack("top", 3), stack("middle", 2)] : []),
        ]),
      ),
  });
  expect(await slot.findByText("Stack of 3 · merges bottom first")).toBeTruthy();
  expect(navRows(slot)).toEqual([key("top"), key("middle"), key("bottom")]);
});

test("200 rows mount no more than the visible rows plus 24", async () => {
  const rows = Array.from({ length: 200 }, (_, index) =>
    row(`scott/b${String(index).padStart(3, "0")}`),
  );
  const slot = render({ inbox: () => ({ smsunarto: read(rows) }) });
  await waitFor(() => expect(navRows(slot).length).toBeGreaterThan(0));
  // The window's first height guess is 800 px; a row is 56 px tall.
  const visible = Math.ceil(800 / 56);
  expect(navRows(slot).length).toBeLessThanOrEqual(visible + 2 * OVERSCAN);
  expect(slot.getByText("All 200")).toBeTruthy();
});

test("a row opens the review page at its deep link", async () => {
  const target = row("scott/x y", { title: "Deep link" });
  const slot = render({ inbox: () => ({ smsunarto: read([target]) }) });
  fireEvent.click(await slot.findByText("Deep link"));
  expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
    method: "toPluginPanel",
    path: "source-control",
    options: { subPath: reviewPath({ key: target.key }) },
  });
});

test("deep links round-trip a key and path holding slashes, colons and spaces", () => {
  const changeKey: ChangeKey = changeKeySchema.parse("local:host-1:/Users/me/My Repo/.git:feat/x");
  const location = {
    key: changeKey,
    tab: "commits" as const,
    commit: "abc1234",
    path: "src/a b/c.ts",
    line: 42,
  };
  // bb encodes each segment of the subPath it is handed; the panel gets it encoded.
  const encoded = reviewPath(location).split("/").map(encodeURIComponent).join("/");
  expect(parseReviewPath(encoded)).toEqual(location);
  const files = reviewPath({ key: changeKey });
  expect(parseReviewPath(files.split("/").map(encodeURIComponent).join("/"))).toEqual({
    key: changeKey,
    tab: "guided",
    commit: null,
    path: null,
    line: null,
  });
  expect(parseReviewPath("c/%ZZ/files").key).toBeNull();
});

test("a lockfile starts collapsed and its patch is not read", async () => {
  const target = row("scott/lock", { title: "Bump deps" });
  const slot = render(
    {
      inbox: () => ({ smsunarto: read([target]) }),
      changeDetail: ({ keys }) => Object.fromEntries(keys.map((k) => [k, detail(target)])),
      changeFiles: () => ({
        ok: true as const,
        files: [file("pnpm-lock.yaml"), file("src/app.ts")],
        more: false,
      }),
    },
    reviewPath({ key: target.key }),
  );
  await waitFor(() => expect(slot.getAllByTestId("sc-file-card")).toHaveLength(2));
  const cards = slot.getAllByTestId("sc-file-card");
  // Reading order puts generated files last.
  expect(
    cards.map((card) => [card.getAttribute("data-path"), card.getAttribute("data-open")]),
  ).toEqual([
    ["src/app.ts", "true"],
    ["pnpm-lock.yaml", "false"],
  ]);
  await waitFor(() => expect(slot.getByTestId("sc-patch-empty")).toBeTruthy());
  const asked = slot.inspection.rpcCalls
    .filter((call) => call.method === "changePatches")
    .flatMap((call) => (call.input as { paths: string[] }).paths);
  expect(asked).toEqual(["src/app.ts"]);
  // Opening it reads only it, once.
  fireEvent.click(slot.getByRole("button", { name: /pnpm-lock\.yaml/ }));
  await waitFor(() => expect(slot.getAllByTestId("sc-patch-empty")).toHaveLength(2));
  const after = slot.inspection.rpcCalls.filter((call) => call.method === "changePatches");
  expect(after.map((call) => (call.input as { paths: string[] }).paths)).toEqual([
    ["src/app.ts"],
    ["pnpm-lock.yaml"],
  ]);
});
