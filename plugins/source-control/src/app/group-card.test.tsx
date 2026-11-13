// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { groupDirective } from "../core/directive.ts";
import { changeKeySchema, type ChangeKey } from "../core/ids.ts";
import type { ChangeDetail } from "../core/review.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { ChangeDirective } from "./chat-card.tsx";
import { LegacyReviewDirective } from "./legacy-card.tsx";

afterEach(cleanup);

const message = { id: "m1", threadId: "thread-a", turnId: null, projectId: null };
const one = changeKeySchema.parse("gh:acme/api:scott:scott/one");
const two = changeKeySchema.parse("gh:acme/api:scott:scott/two");
const HEADS: Record<string, string> = { [one]: "a".repeat(40), [two]: "b".repeat(40) };
const NUMBERS: Record<string, number> = { [one]: 11, [two]: 12 };

const done = (id: string) => ({ id, label: id, state: "done", detail: [] });

/** How a Change reads on the card: an open pull request (ready or still checking), merged, or not read yet. */
type Shape = "ready" | "running" | "merged" | "pending" | "missing";

function detail(key: ChangeKey, ready: boolean | Shape): ChangeDetail {
  const shape: Shape = typeof ready === "boolean" ? (ready ? "ready" : "running") : ready;
  if (shape === "pending") return { state: "pending" };
  if (shape === "missing") return { state: "missing", problem: null };
  const merged = shape === "merged";
  return {
    state: "change",
    row: {
      key,
      repo: "acme/api",
      title: `Change ${NUMBERS[key]}`,
      branch: key.split(":").at(-1)!,
      baseRef: "main",
      number: NUMBERS[key]!,
      url: null,
      author: null,
      mine: true,
      asked: false,
      state: merged ? "merged" : "open",
      stack: null,
      hostId: null,
      line: "",
      chips: [],
      sort: 0,
      updatedAt: null,
    },
    head: HEADS[key]!,
    files: null,
    additions: null,
    deletions: null,
    revision: null,
    stack: null,
    canMarkReady: false,
    ship: ["committed", "pushed", "pullRequest", "approval", "merged"].map(done).concat([
      {
        id: "checks",
        label: "checks",
        state: shape === "running" ? "running" : "done",
        detail: [],
      },
    ]),
    status: merged
      ? { label: "Merged", tone: "merged", number: NUMBERS[key]!, noPullRequest: false }
      : { label: "Open", tone: "open", number: NUMBERS[key]!, noPullRequest: false },
    problem: null,
    at: Date.now(),
  } as ChangeDetail;
}

function attributesOf(directive: string) {
  return { changes: /changes="([^"]*)"/.exec(directive)![1]! };
}

function renderGroup(
  options: {
    ready?: boolean;
    shapes?: Partial<Record<ChangeKey, Shape>>;
    failRead?: boolean;
    merge?: (input: { key: string }) => unknown;
  } = {},
) {
  const calls: { method: string; input: unknown }[] = [];
  const record =
    <T,>(method: string, answer: (input: never) => T) =>
    (input: never) => {
      calls.push({ method, input });
      return answer(input);
    };
  const slot = renderSlot(
    { component: ChangeDirective },
    {
      attributes: attributesOf(
        groupDirective([
          { key: one, revision: HEADS[one]! },
          { key: two, revision: HEADS[two]! },
        ]),
      ),
      source: "",
      message,
      openWorkspaceFile: null,
    },
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      rpc: {
        changeDetail: ({ keys }: { keys: ChangeKey[] }) => {
          if (options.failRead) throw new Error("The server is unreachable.");
          return Object.fromEntries(
            keys.map((key) => [key, detail(key, options.shapes?.[key] ?? options.ready ?? true)]),
          );
        },
        checksForChange: ({ keys }: { keys: string[] }) =>
          Object.fromEntries(keys.map((key) => [key, { read: null, problem: null }])),
        reviewForChange: () => ({}),
        shipGroup: record("shipGroup", () => ({ ok: true })),
        changeForgeAction: record(
          "changeForgeAction",
          options.merge ?? (() => ({ status: "done" })),
        ),
      } as never,
    },
  );
  const of = (method: string) => calls.filter((call) => call.method === method);
  return { slot, of };
}

test("a grouped card shows each Change once, without its own Merge it, and Ship all asks the agent", async () => {
  const { slot, of } = renderGroup();
  await waitFor(() => expect(slot.getAllByTestId("sc-card")).toHaveLength(2));
  expect(slot.queryByTestId("sc-card-merge")).toBeNull();
  await act(async () => (await slot.findByTestId("sc-group-ship")).click());
  await waitFor(() => expect(of("shipGroup")).toHaveLength(1));
  expect(of("shipGroup")[0]!.input).toEqual({
    threadId: "thread-a",
    changes: [
      { key: one, revision: HEADS[one] },
      { key: two, revision: HEADS[two] },
    ],
  });
  expect(await slot.findByText("Asked the agent to ship them.")).toBeTruthy();
});

test("Merge all appears only when every pull request is ready", async () => {
  const { slot } = renderGroup({ ready: false });
  await waitFor(() => expect(slot.getAllByTestId("sc-card")).toHaveLength(2));
  expect(slot.queryByTestId("sc-group-merge")).toBeNull();
});

test("Merge all confirms, merges each pinned to the head shown, and stops at the first failure", async () => {
  const { slot, of } = renderGroup({
    merge: ({ key }) =>
      key === one
        ? { status: "done" }
        : { status: "conflict", detail: "#12 moved since you looked." },
  });
  await act(async () => (await slot.findByTestId("sc-group-merge")).click());
  expect(of("changeForgeAction")).toHaveLength(0);
  await act(async () => slot.getByTestId("sc-group-merge-confirm").click());
  const outcome = await slot.findByTestId("sc-group-merge-outcome");
  expect(outcome.textContent).toBe("Merged #11. Stopped at #12: #12 moved since you looked.");
  expect(of("changeForgeAction").map((call) => call.input)).toEqual([
    {
      key: one,
      action: { kind: "merge", method: "squash", base: "main" },
      expected: { number: 11, head: HEADS[one] },
    },
    {
      key: two,
      action: { kind: "merge", method: "squash", base: "main" },
      expected: { number: 12, head: HEADS[two] },
    },
  ]);
});

test("a card whose pull requests have all merged says so and offers neither Ship all nor Merge all", async () => {
  const { slot } = renderGroup({ shapes: { [one]: "merged", [two]: "merged" } });
  const landed = await slot.findByTestId("sc-group-landed");
  expect(landed.textContent).toBe("All 2 merged.");
  expect(slot.getAllByTestId("sc-card")).toHaveLength(2);
  expect(slot.queryByTestId("sc-group-ship")).toBeNull();
  expect(slot.queryByTestId("sc-group-merge")).toBeNull();
});

test("a card already on screen drops Ship all once its pull requests merge", async () => {
  const shapes: Partial<Record<ChangeKey, Shape>> = {};
  const { slot } = renderGroup({ shapes });
  expect((await slot.findByTestId("sc-group-ship")).textContent).toBe("Ship all 2");
  shapes[one] = "merged";
  shapes[two] = "merged";
  await act(async () => slot.experimental_invalidateRpc(null));
  expect((await slot.findByTestId("sc-group-landed")).textContent).toBe("All 2 merged.");
  expect(slot.queryByTestId("sc-group-ship")).toBeNull();
});

test("on a partly merged card, Ship and Merge cover only the pull requests still open", async () => {
  const { slot, of } = renderGroup({ shapes: { [one]: "merged", [two]: "ready" } });
  const ship = await slot.findByTestId("sc-group-ship");
  expect(ship.textContent).toBe("Ship remaining 1");
  expect(slot.getByTestId("sc-group-merge").textContent).toBe("Merge remaining 1");
  expect(slot.getByTestId("sc-group-summary").textContent).toBe("1 of 2 merged.");
  await act(async () => ship.click());
  await waitFor(() => expect(of("shipGroup")).toHaveLength(1));
  expect(of("shipGroup")[0]!.input).toEqual({
    threadId: "thread-a",
    changes: [{ key: two, revision: HEADS[two] }],
  });
  await act(async () => slot.getByTestId("sc-group-merge").click());
  await act(async () => slot.getByTestId("sc-group-merge-confirm").click());
  await slot.findByTestId("sc-group-merge-outcome");
  expect(of("changeForgeAction").map((call) => (call.input as { key: string }).key)).toEqual([two]);
});

test("a card still reading its changes offers no Ship all", async () => {
  const { slot } = renderGroup({ shapes: { [one]: "merged", [two]: "pending" } });
  await slot.findByTestId("sc-group-reading");
  expect(slot.queryByTestId("sc-group-ship")).toBeNull();
  expect(slot.queryByTestId("sc-group-merge")).toBeNull();
});

test("a card that cannot read its changes offers no Ship all", async () => {
  const { slot } = renderGroup({ failRead: true });
  await waitFor(() => expect(slot.getAllByTestId("sc-card-failed")).toHaveLength(2));
  expect(slot.getByTestId("sc-group-summary").textContent).toBe("2 could not be read.");
  expect(slot.queryByTestId("sc-group-ship")).toBeNull();
  expect(slot.queryByTestId("sc-group-merge")).toBeNull();
});

test("a change bb cannot find is left out of Ship all, and blocks Merge all", async () => {
  const { slot, of } = renderGroup({ shapes: { [one]: "missing", [two]: "ready" } });
  const ship = await slot.findByTestId("sc-group-ship");
  expect(ship.textContent).toBe("Ship remaining 1");
  expect(slot.queryByTestId("sc-group-merge")).toBeNull();
  expect(slot.getByTestId("sc-group-summary").textContent).toBe("1 could not be read.");
  await act(async () => ship.click());
  await waitFor(() => expect(of("shipGroup")).toHaveLength(1));
  expect(of("shipGroup")[0]!.input).toEqual({
    threadId: "thread-a",
    changes: [{ key: two, revision: HEADS[two] }],
  });
});

test("an old multi-target Review card renders as one grouped card", async () => {
  const targets = encodeURIComponent(
    JSON.stringify([{ pr: "acme/api#11" }, { pr: "acme/api#12" }]),
  );
  const slot = renderSlot(
    { component: LegacyReviewDirective },
    { attributes: { targets }, source: "", message, openWorkspaceFile: null },
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      rpc: {
        legacyChange: ({ keys }: { keys: string[] }) =>
          Object.fromEntries(
            keys.map((lookup) => [
              lookup,
              { key: lookup.endsWith("#11") ? one : two, problem: null },
            ]),
          ),
        changeDetail: ({ keys }: { keys: ChangeKey[] }) =>
          Object.fromEntries(keys.map((key) => [key, detail(key, true)])),
        checksForChange: ({ keys }: { keys: string[] }) =>
          Object.fromEntries(keys.map((key) => [key, { read: null, problem: null }])),
        reviewForChange: () => ({}),
      } as never,
    },
  );
  await waitFor(() => expect(slot.getAllByTestId("sc-card")).toHaveLength(2));
  expect(slot.getByTestId("sc-group")).toBeTruthy();
  expect(slot.getByTestId("sc-group-merge").textContent).toContain("Merge all 2");
});
