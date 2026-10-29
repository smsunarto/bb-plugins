import assert from "node:assert/strict";
import { test } from "node:test";
import { installDom } from "@bb-plugins/testing";
import type { PluginRpcResult } from "@get-bb/plugin-sdk";
import type { ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import type { rpcContract } from "../server.ts";
import type { VisiblePrLifecycle } from "../lib/pr-metadata.ts";

installDom();
// jsdom has no matchMedia; the vendored Dialog reads it to pick its layout.
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, waitFor } = await import("@testing-library/react");

type Contract = typeof rpcContract;
type PanelProps = ExperimentalThreadActionTabProps;
type StackPayload = PluginRpcResult<Contract["getStack"]>;
type ActionOutcome = PluginRpcResult<Contract["runAction"]>;

async function loadPanel(): Promise<ComponentType<PanelProps>> {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const tab = app.tabs.find(({ id }) => id === "stack");
  assert.ok(tab, "the stack tab is registered");
  return tab.component as ComponentType<PanelProps>;
}

const layer = (name: string, pr: { number: number; lifecycle: VisiblePrLifecycle } | null) => ({
  name,
  isCurrent: false,
  needsRebase: false,
  hasStash: false,
  stashCount: 0,
  pr: pr
    ? {
        number: pr.number,
        url: `https://github.com/example/repo/pull/${pr.number}`,
        title: null,
        lifecycle: pr.lifecycle,
        metadataStale: false,
      }
    : null,
  diff: null,
  aheadOfRemote: 0,
  behindRemote: 0,
});

// `fetchedAt` null is the server's word that the compute overlapped a stack
// operation and the payload proves nothing.
const payload = (fetchedAt: number | null, branches: ReturnType<typeof layer>[]): StackPayload => ({
  stack: { trunk: "main", currentBranch: null, branches, trunkBehind: 1, prunableBranchCount: 0 },
  workspacePath: "/repo",
  error: null,
  checkoutWarning: null,
  pending: null,
  defaultBranch: "main",
  branchPrefix: null,
  detectedBranchPrefix: null,
  settings: { branchPrefix: "", conventionalCommits: false },
  fetchedAt,
});

test("the GitHub Stack tab keeps its saved identity as a thread action tab", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  assert.deepEqual(
    app.tabs.map(({ id, context, availability, title }) => ({ id, context, availability, title })),
    [{ id: "stack", context: { kind: "thread" }, availability: "action", title: "GitHub Stack" }],
  );
});

test("every PR lifecycle renders its own status pill", async () => {
  const Panel = await loadPanel();
  const slot = renderSlot(
    { component: Panel },
    { threadId: "thr_1", params: null, environment: null },
    {
      rpc: {
        getStack: () =>
          payload(1000, [
            layer("layer-open", { number: 1, lifecycle: "open" }),
            layer("layer-draft", { number: 2, lifecycle: "draft" }),
            layer("layer-queued", { number: 3, lifecycle: "queued" }),
            layer("layer-closed", { number: 4, lifecycle: "closed" }),
            layer("layer-unknown", { number: 5, lifecycle: "unknown" }),
            layer("layer-unsubmitted", null),
          ]),
      },
    },
  );
  await slot.findByText("Open");
  for (const label of ["Draft", "Queued", "Closed", "Unknown", "Unsubmitted"]) {
    assert.ok(slot.getByText(label), label);
  }
  slot.unmount();
});

// The base pinned "queue-like states other than QUEUED block the merge
// prefix"; the wire now folds such a state to the unknown lifecycle, and the
// panel must neither select it nor read it as open.
test("a PR whose state gh-stack could not name blocks the merge", async () => {
  const Panel = await loadPanel();
  const slot = renderSlot(
    { component: Panel },
    { threadId: "thr_1", params: null, environment: null },
    {
      rpc: {
        getStack: () =>
          payload(1000, [
            layer("layer-unknown", { number: 1, lifecycle: "unknown" }),
            layer("layer-open", { number: 2, lifecycle: "open" }),
          ]),
      },
    },
  );
  await slot.findByText("Unknown");
  const merge = slot.getByRole("button", { name: /^Merge/ }) as HTMLButtonElement;
  assert.equal(merge.disabled, true);
  assert.ok(slot.getByTitle("Merge — #1 has an unrecognized PR state and blocks the stack"));
  slot.unmount();
});

test("a signal-delivered payload newer than the write clears the unverified banner", async () => {
  const Panel = await loadPanel();
  const open = layer("layer-open", { number: 1, lifecycle: "open" });
  let served = payload(1000, [open]);
  const written: ActionOutcome = {
    ok: true,
    message: "Stack sync verified.",
    detail: null,
    fetchedAt: 2000,
  };
  const slot = renderSlot(
    { component: Panel },
    { threadId: "thr_1", params: null, environment: null },
    {
      rpc: {
        // The fresh re-read that follows the write fails; later cached
        // polls serve whatever the server has by then.
        getStack: (input: unknown) =>
          (input as { refresh?: boolean }).refresh ? Promise.reject(new Error("offline")) : served,
        runAction: () => written,
      },
    },
  );
  fireEvent.click(await slot.findByRole("button", { name: "Sync" }));
  const banner = /latest state could not be loaded/;
  await slot.findByText(banner);

  // A payload computed before the write finished proves nothing.
  served = payload(1500, [open]);
  await slot.behavior.emitRealtime("stack-updated", { threadId: "thr_1", fetchedAt: 1500 });
  await waitFor(() => assert.equal(slot.queryByText("offline"), null));
  assert.ok(slot.getByText(banner));

  served = payload(2500, [open]);
  await slot.behavior.emitRealtime("stack-updated", { threadId: "thr_1", fetchedAt: 2500 });
  await waitFor(() => assert.equal(slot.queryByText(banner), null));
  slot.unmount();
});

// Write-verification fixtures: a panel over the given RPC handlers, the
// fresh-read discriminator, and the banner the panel shows while a write is
// unverified.
const mountPanel = (
  Panel: ComponentType<PanelProps>,
  rpc: Record<string, (input: unknown) => unknown>,
) =>
  renderSlot({ component: Panel }, { threadId: "thr_1", params: null, environment: null }, { rpc });

const isFresh = (input: unknown) => (input as { refresh?: boolean }).refresh === true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const BANNER = /latest state could not be loaded/;
const SYNCED: ActionOutcome = {
  ok: true,
  message: "Stack sync verified.",
  detail: null,
  fetchedAt: 2000,
};

test("a payload that proves the write while its re-read is in flight verifies it even if the re-read then fails", async () => {
  const Panel = await loadPanel();
  const open = layer("layer-open", { number: 1, lifecycle: "open" });
  let served = payload(1000, [open]);
  const fresh = deferred<never>();
  let freshRequested = false;
  const slot = mountPanel(Panel, {
    getStack: (input: unknown) => {
      if (!isFresh(input)) return served;
      freshRequested = true;
      return fresh.promise;
    },
    runAction: () => SYNCED,
  });
  fireEvent.click(await slot.findByRole("button", { name: "Sync" }));
  await waitFor(() => assert.ok(freshRequested, "the post-write re-read is in flight"));

  // Another panel's compute, announced on the channel, lands first.
  served = payload(2500, [open, layer("layer-announced", null)]);
  await slot.behavior.emitRealtime("stack-updated", { threadId: "thr_1", fetchedAt: 2500 });
  await slot.findByText("layer-announced");

  fresh.reject(new Error("offline"));
  await slot.findByText("offline");
  assert.equal(slot.queryByText(BANNER), null);
  const sync = slot.getByRole("button", { name: "Sync" }) as HTMLButtonElement;
  assert.equal(sync.disabled, false);
  slot.unmount();
});

test("a mutation that fails before the server can stamp it stays unverified until a fresh read succeeds", async () => {
  const Panel = await loadPanel();
  const open = layer("layer-open", { number: 1, lifecycle: "open" });
  let served = payload(1000, [open]);
  let freshFails = true;
  const slot = mountPanel(Panel, {
    getStack: (input: unknown) =>
      isFresh(input) && freshFails ? Promise.reject(new Error("offline")) : served,
    runAction: () => Promise.reject(new Error("socket closed")),
  });
  fireEvent.click(await slot.findByRole("button", { name: "Sync" }));
  await slot.findByText(BANNER);

  // With no server stamp there is no floor: a poll or signal payload, however
  // new, may have been computed before the write and proves nothing.
  served = payload(5000, [open]);
  await slot.behavior.emitRealtime("stack-updated", { threadId: "thr_1", fetchedAt: 5000 });
  await waitFor(() => assert.equal(slot.queryByText("offline"), null));
  assert.ok(slot.getByText(BANNER));

  // Only a fresh read, issued after the call ended, does.
  freshFails = false;
  served = payload(6000, [open]);
  fireEvent.click(slot.getByRole("button", { name: "Refresh stack" }));
  await waitFor(() => assert.equal(slot.queryByText(BANNER), null));
  slot.unmount();
});

test("a payload computed during a stack operation carries no stamp and proves nothing", async () => {
  const Panel = await loadPanel();
  const open = layer("layer-open", { number: 1, lifecycle: "open" });
  let served = payload(1000, [open]);
  const slot = mountPanel(Panel, {
    getStack: (input: unknown) =>
      isFresh(input) ? payload(null, [open, layer("layer-mid-operation", null)]) : served,
    runAction: () => SYNCED,
  });
  await slot.findByText("layer-open");
  fireEvent.click(slot.getByRole("button", { name: "Sync" }));
  await slot.findByText(BANNER);
  // An unstamped payload never displaces the stamped one the panel holds.
  assert.equal(slot.queryByText("layer-mid-operation"), null);
  assert.ok(slot.getByTitle(/Last updated/));

  served = payload(2500, [open]);
  await slot.behavior.emitRealtime("stack-updated", { threadId: "thr_1", fetchedAt: 2500 });
  await waitFor(() => assert.equal(slot.queryByText(BANNER), null));
  slot.unmount();
});
