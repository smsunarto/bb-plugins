// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { changeKeySchema } from "../core/ids.ts";
import type { ChangeRow } from "../core/review.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { OtherMachinesCard } from "./other-machines.tsx";

afterEach(cleanup);

const KEY = changeKeySchema.parse("gh:acme/api:scott:scott/route");

function row(branch: string, repo = "acme/api"): ChangeRow {
  return {
    key: changeKeySchema.parse(`gh:${repo}:scott:${branch}`),
    repo,
    title: branch,
    branch,
    baseRef: "main",
    number: null,
    url: null,
    author: null,
    mine: true,
    asked: false,
    state: "local",
    stack: null,
    hostId: "host-b",
    line: "",
    chips: [],
    sort: 0,
    updatedAt: null,
  };
}

function render(hostChanges: (keys: string[]) => unknown) {
  const calls: string[][] = [];
  const slot = renderSlot(
    { component: OtherMachinesCard as never },
    { hostId: "host-a", repo: "acme/api", changeKey: KEY, now: 1_000_000, className: "" } as never,
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      rpc: {
        checkoutHosts: () => ({
          hosts: [
            { hostId: "host-a", name: "this-mac" },
            { hostId: "host-b", name: "build-linux" },
            { hostId: "host-c", name: "laptop" },
          ],
        }),
        hostChanges: ({ keys }: { keys: string[] }) => {
          calls.push(keys);
          return hostChanges(keys);
        },
      } as never,
    },
  );
  return { slot, calls };
}

test("folded, it reads nothing; opened, it lists this repository's branches on each other host", async () => {
  const { slot, calls } = render((keys) =>
    Object.fromEntries(
      keys.map((key) => [
        key,
        key === "host-b"
          ? {
              read: {
                rows: [row("other"), row("x", "acme/web"), row("scott/route")],
                at: 1_000_000,
              },
              problem: null,
            }
          : { read: { rows: [], at: 1_000_000 }, problem: null },
      ]),
    ),
  );
  expect(calls).toEqual([]);
  await act(async () => slot.getByRole("button", { name: "Other machines" }).click());
  const hosts = await slot.findAllByTestId("sc-other-host");
  expect(hosts.map((host) => host.getAttribute("aria-label"))).toEqual([
    "On build-linux",
    "On laptop",
  ]);
  await waitFor(() => expect(hosts[0]!.textContent).toContain("This change"));
  // This thread's Change first; another repository's branch not at all.
  expect([...hosts[0]!.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "Unpushedscott/routeThis change",
    "Unpushedother",
  ]);
  expect(hosts[1]!.textContent).toContain("No checkout of acme/api here.");
  expect(calls.flat()).not.toContain("host-a");
});

test("an offline host shows its last read and why, and one never read says only why", async () => {
  const offline = { kind: "host-offline", host: "laptop" };
  const { slot } = render((keys) =>
    Object.fromEntries(
      keys.map((key) => [
        key,
        key === "host-b"
          ? { read: { rows: [row("other")], at: 1_000_000 - 600_000 }, problem: offline }
          : { read: null, problem: offline },
      ]),
    ),
  );
  await act(async () => slot.getByRole("button", { name: "Other machines" }).click());
  const hosts = await slot.findAllByTestId("sc-other-host");
  await waitFor(() =>
    expect(hosts[0]!.textContent).toContain("laptop is not answering. Read 10 min ago."),
  );
  expect(hosts[0]!.textContent).toContain("other");
  expect(hosts[1]!.textContent).toContain("laptop is not answering.");
  expect(hosts[1]!.querySelector("[aria-busy]")).toBeNull();
});

test("a host not read yet stays pending while the others show", async () => {
  const { slot } = render((keys) =>
    Object.fromEntries(
      keys.map((key) => [
        key,
        key === "host-b"
          ? { read: { rows: [row("other")], at: 1_000_000 }, problem: null }
          : { read: null, problem: null },
      ]),
    ),
  );
  await act(async () => slot.getByRole("button", { name: "Other machines" }).click());
  const hosts = await slot.findAllByTestId("sc-other-host");
  await waitFor(() => expect(hosts[0]!.textContent).toContain("other"));
  expect(hosts[1]!.querySelector('[aria-busy="true"]')).not.toBeNull();
});
