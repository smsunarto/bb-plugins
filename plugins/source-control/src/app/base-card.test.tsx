// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { sourceControlContract } from "../contract/rpc.ts";
import { BaseCard } from "./base-card.tsx";

afterEach(cleanup);

const BASE = "a".repeat(40);
const target = {
  ref: "origin/main",
  head: "b".repeat(40),
  behind: 0,
  base: { id: BASE, subject: "Merge the forge router" },
  lastFetched: null,
};
const commit = (n: number) => ({
  id: `${n}`.padStart(40, "c"),
  subject: `older ${n}`,
  createdAt: "2026-11-01T00:00:00Z",
});

function render(answer: (input: { limit: number }) => unknown) {
  const calls: { from: string; limit: number }[] = [];
  const slot = renderSlot(
    { component: BaseCard as never },
    { threadId: "thread-a", target, now: Date.now(), className: "" } as never,
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      rpc: {
        baseHistory: (input: { from: string; limit: number }) => {
          calls.push({ from: input.from, limit: input.limit });
          return answer(input);
        },
      } as never,
    },
  );
  return { slot, calls };
}

test("folded, it shows the base from the workspace read and asks the host nothing", () => {
  const { slot, calls } = render(() => ({ ok: true, value: { commits: [], hasMore: false } }));
  expect(slot.getByTestId("sc-base-card").textContent).toContain("Merge the forge router");
  expect(slot.getByTestId("sc-base-card").textContent).toContain("on origin/main");
  expect(calls).toEqual([]);
});

test("opened, it reads the history under the base a page at a time", async () => {
  const { slot, calls } = render(({ limit }) => ({
    ok: true,
    value: { commits: Array.from({ length: limit }, (_, n) => commit(n)), hasMore: true },
  }));
  await act(async () => slot.getByRole("button", { name: /Common base/ }).click());
  await waitFor(() => expect(slot.getAllByTestId("sc-base-commit")).toHaveLength(20));
  expect(calls).toEqual([{ from: BASE, limit: 20 }]);
  await act(async () => slot.getByRole("button", { name: "Show earlier commits" }).click());
  await waitFor(() => expect(slot.getAllByTestId("sc-base-commit")).toHaveLength(40));
  expect(calls.at(-1)).toEqual({ from: BASE, limit: 40 });
});

test("a host that cannot read it says why and offers a retry", async () => {
  const { slot } = render(() => ({
    ok: false,
    problem: { kind: "host-offline", host: "studio-mac" },
  }));
  await act(async () => slot.getByRole("button", { name: /Common base/ }).click());
  expect(await slot.findByText(/studio-mac is not answering/)).toBeTruthy();
  expect(slot.getByRole("button", { name: "Try again" })).toBeTruthy();
});
