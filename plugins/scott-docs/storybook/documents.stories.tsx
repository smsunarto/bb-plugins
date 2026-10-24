import { recoveryPlan } from "../../../.storybook/fixtures";
import { screenParameters } from "../../../.storybook/layout";
import { ready, shows } from "../../../.storybook/ready";
import { clearNotebookStores } from "../app";
import { expect, waitFor } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { nav } from "../../../.storybook/surfaces";
const source = () => import("../app");
const vault = {
  id: "personal",
  name: "Atlas handbook",
  hostId: "host_local",
  rootPath: "/home/maya/notes/atlas",
};
const notes = [
  {
    path: "design.md",
    title: "Offline review recovery",
    preview: "Keep cached reviews readable while checkout hosts reconnect.",
    modifiedAtMs: Date.parse("2026-10-23T10:40:00Z"),
  },
  {
    path: "release-checklist.md",
    title: "Autumn release checklist",
    preview: "Desktop QA, API migration, rollback owner, and launch approval.",
    modifiedAtMs: Date.parse("2026-10-23T09:20:00Z"),
  },
  {
    path: "engineering/README.md",
    title: "Engineering handbook",
    preview: "Local development, pull request review, and test conventions.",
    modifiedAtMs: Date.parse("2026-10-22T14:10:00Z"),
  },
  {
    path: "engineering/cache-ownership.md",
    title: "Cache ownership and invalidation",
    preview: "Keys belong to the selected checkout. Superseded requests cannot write.",
    modifiedAtMs: Date.parse("2026-10-22T11:00:00Z"),
  },
  {
    path: "runbooks/host-reconnect.md",
    title: "Reconnect a sleeping build host",
    preview: "Check enrollment, wake the machine, then verify the active checkout.",
    modifiedAtMs: Date.parse("2026-10-21T16:45:00Z"),
  },
  {
    path: "runbooks/rollback.md",
    title: "Release rollback",
    preview: "Restore the previous image and verify the database compatibility gate.",
    modifiedAtMs: Date.parse("2026-10-21T12:30:00Z"),
  },
  {
    path: "decisions/004-review-snapshots.md",
    title: "ADR 004 · Revisioned review snapshots",
    preview: "Why snapshots carry checkout identity and source revision.",
    modifiedAtMs: Date.parse("2026-10-20T15:00:00Z"),
  },
];
const listing = {
  vaults: [vault],
  vault,
  hosts: [{ id: "host_local", name: "Design MacBook", status: "connected" }],
  entries: [
    { kind: "directory", path: "engineering" },
    { kind: "directory", path: "runbooks" },
    { kind: "directory", path: "decisions" },
    ...notes.map((n) => ({ kind: "file", path: n.path })),
  ],
  entryOrder: [],
  notes,
  truncated: false,
  error: null,
};
const meta = {
  beforeEach: () => clearNotebookStores(),
  play: ready,
  title: "Screens/Docs/Document browser",
  component: RegisteredSurface,
  args: { source, select: (app) => nav(app, "personal", "navigation") },
  parameters: {
    ...screenParameters,
    editorContext: { placement: "page-panel", title: "Docs", tab: "Navigation" },
    host: { pluginId: "scott-docs", rpc: { listNotes: () => listing } },
  },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Notes: Story = {
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(
        canvasElement
          .querySelector("[data-docs-tree]")
          ?.shadowRoot?.querySelector('[role="treeitem"][aria-label="design.md"]'),
      ).toBeTruthy(),
    );
  },
};
export const Empty: Story = {
  play: async (context) => {
    await ready(context);
    await waitFor(() => {
      const tree = context.canvasElement.querySelector("[data-docs-tree]")?.shadowRoot;
      expect(tree).toBeTruthy();
      expect(tree?.querySelectorAll('[role="treeitem"]').length).toBe(0);
    });
  },
  parameters: { host: { rpc: { listNotes: () => ({ ...listing, entries: [], notes: [] }) } } },
};
export const Offline: Story = {
  play: shows(/Could not load vaults: Host unavailable/),
  parameters: {
    host: { rpc: { listNotes: () => Promise.reject(new globalThis.Error("Host unavailable")) } },
  },
};
export const MarkdownEditor: Story = {
  args: { select: (app) => nav(app, "personal/design.md") },
  parameters: {
    editorContext: { placement: "page", title: "Docs" },
    host: {
      rpc: {
        listNotes: () => listing,
        readNote: () => ({
          content: recoveryPlan,
          sha256: "storybook-note",
        }),
        readProposal: () => null,
        preparePreview: () => ({ baseUrl: "/", expiresAtMs: Date.now() + 60000 }),
      },
    },
  },
};
