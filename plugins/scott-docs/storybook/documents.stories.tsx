import { ready, shows } from "../../../.storybook/ready";
import { clearNotebookStores } from "../app";
import { expect, waitFor } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { nav } from "../../../.storybook/surfaces";
const source = () => import("../app");
const vault = {
  id: "personal",
  name: "Personal",
  hostId: "host_local",
  rootPath: "/home/developer/notes",
};
const notes = [
  {
    path: "engineering/README.md",
    title: "Engineering",
    preview: "Team practices",
    modifiedAtMs: 1,
  },
  { path: "design.md", title: "Design review", preview: "Review notes", modifiedAtMs: 2 },
];
const listing = {
  vaults: [vault],
  vault,
  hosts: [{ id: "host_local", name: "Workstation", status: "connected" }],
  entries: [
    { kind: "directory", path: "engineering" },
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
  parameters: { host: { pluginId: "scott-docs", rpc: { listNotes: () => listing } } },
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
    host: {
      rpc: {
        listNotes: () => listing,
        readNote: () => ({
          content:
            "# Design review\n\nKeep controls reachable in narrow panels.\n\n- [ ] Review empty states\n- [x] Verify keyboard access",
          sha256: "storybook-note",
        }),
        readProposal: () => null,
        preparePreview: () => ({ baseUrl: "/", expiresAtMs: Date.now() + 60000 }),
      },
    },
  },
};
