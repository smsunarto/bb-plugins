// @vitest-environment jsdom
import { act, cleanup, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { LocalValue, ThreadChange } from "../core/change.ts";
import { changeKeySchema } from "../core/ids.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { writeSnapshot } from "./snapshot.ts";

const app = await loadPluginApp(() => import("./app.tsx"));
type ThreadTab = {
  component: ComponentType<{ threadId: string; environment: { id: string } | null }>;
};
const tab = app.tabs.find((registration) => registration.id === "changes") as unknown as ThreadTab;

function local(branch: string): LocalValue {
  return {
    path: `/work/${branch}`,
    commonDir: `/work/${branch}/.git`,
    branch,
    head: "c0ffee",
    github: { repo: { owner: "smsunarto", name: "bb-plugins" }, headOwner: "smsunarto" },
    upstream: { ref: `origin/${branch}`, ahead: 1, behind: 0 },
    uncommitted: [{ path: "a.ts", kind: "modified" }],
    moreUncommitted: 0,
    conflicted: 0,
    commits: [],
  };
}

function checkout(
  branch: string,
  title: string | null,
  overrides: Partial<Extract<ThreadChange, { state: "checkout" }>> = {},
): ThreadChange {
  return {
    state: "checkout",
    placement: {
      hostId: "host-a",
      hostName: "studio-mac",
      path: `/work/${branch}`,
      environmentId: "env",
    },
    key: changeKeySchema.parse(`gh:smsunarto/bb-plugins:smsunarto:${branch}`),
    local: { read: { value: local(branch), at: Date.now() - 12 * 60_000 }, problem: null },
    forge: {
      read: {
        value: title
          ? {
              number: 482,
              url: "https://github.com/x",
              title,
              state: "open",
              isDraft: true,
              headRefOid: "c0ffee",
              baseRef: "main",
              reviewDecision: null,
              checks: { passed: 4, failed: 0, pending: 0 },
            }
          : null,
        at: Date.now(),
      },
      problem: null,
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

test("the last snapshot paints while the read is still pending", async () => {
  writeSnapshot("thread-a", checkout("scott/route-gh", "Route gh through the checkout host"));
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    {
      experimental_rpcContract: sourceControlContract,
      rpc: {
        changeForThread: () => new Promise(() => {}),
        refreshThread: () => ({ ok: true as const }),
      },
    },
  );
  expect(await slot.findByText("Route gh through the checkout host")).toBeTruthy();
  expect(slot.getByTestId("sc-read-state").textContent).toBe("Read 12 min ago");
});

test("with neither data nor snapshot, the loading skeleton reserves the layout", async () => {
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    {
      experimental_rpcContract: sourceControlContract,
      rpc: {
        changeForThread: () => new Promise(() => {}),
        refreshThread: () => ({ ok: true as const }),
      },
    },
  );
  expect(slot.getByTestId("sc-loading")).toBeTruthy();
  expect(slot.getByTestId("sc-read-state").textContent).toBe("Reading…");
});

test("a late answer for thread A is never drawn in thread B's pane", async () => {
  const answers = { "thread-a": deferred<ThreadChange>(), "thread-b": deferred<ThreadChange>() };
  const rpc = {
    changeForThread: async (input: unknown) => {
      const { keys } = input as { keys: (keyof typeof answers)[] };
      return Object.fromEntries(
        await Promise.all(keys.map(async (key) => [key, await answers[key].promise] as const)),
      );
    },
    refreshThread: () => ({ ok: true as const }),
  };
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    { experimental_rpcContract: sourceControlContract, rpc },
  );
  const Tab = tab.component;
  slot.lifecycle.rerender(<Tab threadId="thread-b" environment={{ id: "env" }} />);
  // A answers after the pane moved to B, while B is still reading.
  await act(async () => answers["thread-a"].resolve(checkout("scott/a", "Change A")));
  await new Promise((settle) => setTimeout(settle, 20));
  expect(slot.queryByText("Change A")).toBeNull();
  expect(slot.getByTestId("sc-loading")).toBeTruthy();
  await act(async () => answers["thread-b"].resolve(checkout("scott/b", "Change B")));
  expect(await slot.findByText("Change B")).toBeTruthy();
  expect(slot.queryByText("Change A")).toBeNull();
});

test("switching from A to B shows B reading, never A's Change", async () => {
  const b = deferred<ThreadChange>();
  const rpc = {
    changeForThread: async (input: unknown) => {
      const { keys } = input as { keys: string[] };
      return Object.fromEntries(
        await Promise.all(
          keys.map(
            async (key) =>
              [
                key,
                key === "thread-a" ? checkout("scott/a", "Change A") : await b.promise,
              ] as const,
          ),
        ),
      );
    },
    refreshThread: () => ({ ok: true as const }),
  };
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    { experimental_rpcContract: sourceControlContract, rpc },
  );
  expect(await slot.findByText("Change A")).toBeTruthy();
  const Tab = tab.component;
  slot.lifecycle.rerender(<Tab threadId="thread-b" environment={{ id: "env" }} />);
  await new Promise((settle) => setTimeout(settle, 20));
  expect(slot.queryByText("Change A")).toBeNull();
  expect(slot.getByTestId("sc-loading")).toBeTruthy();
  await act(async () => b.resolve(checkout("scott/b", "Change B")));
  expect(await slot.findByText("Change B")).toBeTruthy();
});

test("offline keeps the last read and says which host is not answering", async () => {
  const row = checkout("scott/route-gh", "Route gh through the checkout host", {});
  if (row.state !== "checkout") throw new Error("fixture");
  row.local.problem = { kind: "host-offline", host: "studio-mac" };
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    {
      experimental_rpcContract: sourceControlContract,
      rpc: {
        changeForThread: () => ({ "thread-a": row }),
        refreshThread: () => ({ ok: true as const }),
      },
    },
  );
  expect((await slot.findByTestId("sc-stale")).textContent).toContain(
    "studio-mac is not answering",
  );
  expect(slot.getByText("Route gh through the checkout host")).toBeTruthy();
  expect(slot.getByTestId("sc-read-state").textContent).toBe("Read 12 min ago");
});

test("a failed first read says what broke and retries only when asked", async () => {
  let refreshes = 0;
  const row: ThreadChange = {
    state: "checkout",
    placement: { hostId: "host-b", hostName: "build-linux", path: "/w", environmentId: "env" },
    key: null,
    local: {
      read: null,
      problem: {
        kind: "tool-missing",
        tool: "git",
        host: "build-linux",
        detail: "git: command not found",
      },
    },
    forge: { read: null, problem: null },
  };
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    {
      experimental_rpcContract: sourceControlContract,
      rpc: {
        changeForThread: () => ({ "thread-a": row }),
        refreshThread: () => (refreshes++, { ok: true as const }),
      },
    },
  );
  expect((await slot.findByTestId("sc-failed")).textContent).toContain("build-linux has no git");
  expect(refreshes).toBe(0);
  await act(async () => slot.getByRole("button", { name: "Try again" }).click());
  await waitFor(() => expect(refreshes).toBe(1));
});

test("a first read that finds the host asleep does not claim a last read", async () => {
  const row: ThreadChange = {
    state: "checkout",
    placement: { hostId: "host-a", hostName: "dev-pc", path: "/w", environmentId: "env" },
    key: null,
    local: { read: null, problem: { kind: "host-offline", host: "dev-pc" } },
    forge: { read: null, problem: null },
  };
  const slot = renderSlot(
    tab,
    { threadId: "thread-a", environment: { id: "env" } },
    {
      experimental_rpcContract: sourceControlContract,
      rpc: {
        changeForThread: () => ({ "thread-a": row }),
        refreshThread: () => ({ ok: true as const }),
      },
    },
  );
  const failed = await slot.findByTestId("sc-failed");
  expect(failed.textContent).toContain("dev-pc is not answering.");
  expect(failed.textContent).not.toContain("last read");
});
