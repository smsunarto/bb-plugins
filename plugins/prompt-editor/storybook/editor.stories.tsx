import { ready, shows } from "../../../.storybook/ready";
import { clearDraftsForTest } from "../src/app/app";
import { expect, within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { nav } from "../../../.storybook/surfaces";
const source = () => import("../src/app/app");
const plugin = {
  id: "notes",
  name: "Notes",
  status: "running",
  readOnly: null,
  tools: [
    {
      name: "notes_find",
      live: "Find notes by title.",
      file: "instructions/tools/notes_find.md",
      drift: false,
    },
    { name: "notes_code", live: "Defined in code.", file: null, drift: false },
  ],
  files: [
    {
      path: "instructions/tools/notes_find.md",
      kind: "tool-description",
      tool: "notes_find",
      chars: 20,
    },
  ],
};
const rpc = {
  plugins: () => ({ plugins: [plugin] }),
  file: () => ({
    content: "Find notes by title.\n\nReturn matching titles and paths.",
    placeholders: [],
    maxChars: 4096,
  }),
};
const meta = {
  beforeEach: () => clearDraftsForTest(),
  play: ready,
  title: "Screens/Prompt Editor/Tools and files",
  component: RegisteredSurface,
  args: { source, select: (app) => nav(app, "", "plugins") },
  parameters: { host: { pluginId: "prompt-editor", rpc } },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ToolBrowser: Story = { play: shows("Notes") };
export const FileEditor: Story = {
  args: { select: (app) => nav(app, "notes/file/instructions/tools/notes_find.md") },
};
export const NoSelection: Story = {
  args: { select: (app) => nav(app) },
  play: shows("Pick a tool, prompt, or skill in the Plugins tab."),
};
export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const list = await within(canvasElement).findByRole("navigation", { name: "Plugins" });
    await expect(list.children.length).toBe(0);
  },
  parameters: { host: { pluginId: "prompt-editor", rpc: { plugins: () => ({ plugins: [] }) } } },
};
export const Error: Story = {
  play: shows("Plugin list unavailable"),
  parameters: {
    host: {
      pluginId: "prompt-editor",
      rpc: { plugins: () => Promise.reject(new globalThis.Error("Plugin list unavailable")) },
    },
  },
};
