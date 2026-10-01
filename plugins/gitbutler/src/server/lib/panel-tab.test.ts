import { expect, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { offerPanelTab } from "./panel-tab.ts";

function thread(options: { state?: string; offered?: boolean; tabs?: unknown[] }) {
  const store = {
    metadata: options.offered ? { panelTabOffered: true } : ({} as Record<string, unknown>),
    tabs: {
      revision: 3,
      tabs: options.tabs ?? [{ kind: "git-diff", id: "git-diff:git-diff:none" }],
    },
    updates: [] as unknown[],
  };
  const bb = {
    sdk: {
      threads: {
        get: async () => ({ environment: { hostId: "host-1", path: "/work", status: "ready" } }),
        getPluginMetadata: async () => store.metadata,
        updatePluginMetadata: async ({ set }: { set: Record<string, unknown> }) => {
          store.metadata = { ...store.metadata, ...set };
          return store.metadata;
        },
        tabs: {
          get: async () => store.tabs,
          update: async (args: unknown) => {
            store.updates.push(args);
            return store.tabs;
          },
        },
      },
    },
    hosts: {
      experimental_client: () => ({
        call: async () => ({ state: options.state ?? "ready", stacks: [] }),
      }),
    },
  } as unknown as BbPluginApi;
  return { bb, store };
}

const gitbutlerTab = {
  kind: "plugin-panel",
  id: "plugin-panel:gitbutler%3Agitbutler%3A:none",
  pluginId: "gitbutler",
  actionId: "gitbutler",
  title: "GitButler",
  paramsJson: null,
};

test("adds the tab after the thread's existing tabs, once", async () => {
  const { bb, store } = thread({});
  await offerPanelTab(bb, "t1");
  await offerPanelTab(bb, "t1");

  expect(store.updates).toEqual([
    {
      threadId: "t1",
      expectedRevision: 3,
      tabs: [{ kind: "git-diff", id: "git-diff:git-diff:none" }, gitbutlerTab],
    },
  ]);
  expect(store.metadata).toEqual({ panelTabOffered: true });
});

test("leaves a tab the reader closed closed", async () => {
  const { bb, store } = thread({ offered: true });
  await offerPanelTab(bb, "t1");
  expect(store.updates).toEqual([]);
});

test("does not duplicate a tab that is already open", async () => {
  const { bb, store } = thread({ tabs: [gitbutlerTab] });
  await offerPanelTab(bb, "t1");
  expect(store.updates).toEqual([]);
  expect(store.metadata).toEqual({ panelTabOffered: true });
});

test("waits for a GitButler workspace before offering", async () => {
  const { bb, store } = thread({ state: "setupRequired" });
  await offerPanelTab(bb, "t1");
  expect(store.updates).toEqual([]);
  expect(store.metadata).toEqual({});
});
