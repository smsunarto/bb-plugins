// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { sourceControlContract } from "../contract/rpc.ts";
import { LandedDirective } from "./landed-card.tsx";
import { LegacyReviewDirective, legacyTargets } from "./legacy-card.tsx";

afterEach(cleanup);

const message = { id: "m1", threadId: "thread-a", turnId: null, projectId: null };

test("an old card's attributes name a pull request, a branch, or a list of both; anything else is none", () => {
  expect(legacyTargets({ pr: "acme/api#42", account: "scott" })?.map((t) => t.lookup)).toEqual([
    "pr:acme/api#42",
  ]);
  expect(
    legacyTargets({ branch: "0123456789ab", base: "aaaa111", head: "bbbb222" })?.map((t) => [
      t.lookup,
      t.head,
    ]),
  ).toEqual([["branch:0123456789ab", "bbbb222"]]);
  const targets = encodeURIComponent(
    JSON.stringify([{ pr: "acme/api#1" }, { branch: "0123456789ab", base: "a", head: "zz" }]),
  );
  expect(legacyTargets({ targets })?.map((t) => [t.lookup, t.head])).toEqual([
    ["pr:acme/api#1", null],
    ["branch:0123456789ab", null],
  ]);
  expect(legacyTargets({ pr: "https://evil.example/acme/api/pull/1" })).toBeNull();
  expect(legacyTargets({ targets: "%7Bnot json" })).toBeNull();
});

test("an old card whose pull request no longer resolves says why and links to GitHub", async () => {
  const slot = renderSlot(
    { component: LegacyReviewDirective },
    {
      attributes: { pr: "acme/api#42" },
      source: '::code-review{pr="acme/api#42"}',
      message,
      openWorkspaceFile: null,
    },
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      rpc: {
        legacyChange: ({ keys }: { keys: string[] }) =>
          Object.fromEntries(
            keys.map((key) => [key, { key: null, problem: "GitHub has no such pull request." }]),
          ),
      } as never,
    },
  );
  const card = await slot.findByText(/GitHub has no such pull request\./);
  expect(card.textContent).toContain("Open acme/api#42 on GitHub");
});

test("an unreadable old card shows its source rather than a broken card", () => {
  const slot = renderSlot(
    { component: LegacyReviewDirective },
    {
      attributes: { pr: "nope" },
      source: '::code-review{pr="nope"}',
      message,
      openWorkspaceFile: null,
    },
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      rpc: {} as never,
    },
  );
  expect(slot.getByTestId("sc-legacy-invalid").textContent).toBe('::code-review{pr="nope"}');
});

test("the landed card lists what landed as GitHub reports it", async () => {
  const slot = renderSlot(
    { component: LandedDirective },
    {
      attributes: { prs: "acme/api#42", commits: "acme/api@abcdef1", account: "scott" },
      source: "",
      message,
      openWorkspaceFile: null,
    },
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      sdk: { threads: { get: async () => ({ id: "thread-a", archivedAt: null }) } } as never,
      rpc: {
        landedCard: () => ({
          ok: true,
          landed: {
            prs: [
              {
                ref: { owner: "acme", repo: "api", number: 42 },
                title: "Route gh",
                url: "https://github.com/acme/api/pull/42",
                state: "merged",
              },
            ],
            commits: [
              {
                ref: { owner: "acme", repo: "api", sha: "abcdef1234" },
                branch: "main",
                landed: false,
                headline: "Fix the build",
                url: "https://github.com/acme/api/commit/abcdef1234",
              },
            ],
          },
        }),
      } as never,
    },
  );
  expect(await slot.findByText("1 of 2 landed")).toBeTruthy();
  expect(slot.getByText("Route gh")).toBeTruthy();
  expect(slot.getByText("Fix the build")).toBeTruthy();
});
