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

const payload = (fetchedAt: number, branches: ReturnType<typeof layer>[]): StackPayload => ({
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
