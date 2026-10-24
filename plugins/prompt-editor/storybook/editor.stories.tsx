import { screenParameters } from "../../../.storybook/layout";
import { ready, shows } from "../../../.storybook/ready";
import { clearDraftsForTest } from "../src/app/app";
import { expect, within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { nav } from "../../../.storybook/surfaces";
const source = () => import("../src/app/app");
const toolDescription = `Create a review card for committed changes in a local GitButler branch or a GitHub pull request.

Use the branch's committed head and its review base. Include the returned directive on its own line so the reviewer can open the exact change.

Required: a branch name, or an owner/repository pull request reference.
Optional: host and checkout path when several checkouts share the same branch name.

Uncommitted changes are outside this review. Do not mark files reviewed on the human's behalf.`;
const plugin = {
  id: "code-review",
  name: "Code Review",
  status: "running",
  readOnly: null,
  tools: [
    {
      name: "code_review_share_changes",
      live: toolDescription,
      file: "instructions/tools/code_review_share_changes.md",
      drift: false,
    },
    {
      name: "review_status",
      live: "Read the pinned base, head, and remaining review progress.",
      file: "instructions/tools/review_status.md",
      drift: true,
    },
  ],
  files: [
    {
      path: "instructions/tools/code_review_share_changes.md",
      kind: "tool-description",
      tool: "code_review_share_changes",
      chars: toolDescription.length,
    },
    {
      path: "instructions/tools/review_status.md",
      kind: "tool-description",
      tool: "review_status",
      chars: 212,
    },
    { path: "instructions/review-summary.md", kind: "prompt", tool: null, chars: 684 },
    { path: "skills/review/SKILL.md", kind: "skill", tool: null, chars: 2408 },
  ],
};
const rpc = {
  plugins: () => ({
    plugins: [
      plugin,
      {
        id: "game-studio",
        name: "Game Studio",
        status: "running",
        readOnly: null,
        tools: [
          {
            name: "game_studio_canvas_context",
            live: "Read a saved canvas and its current board revision.",
            file: "instructions/tools/game_studio_canvas_context.md",
            drift: false,
          },
        ],
        files: [
          {
            path: "instructions/tools/game_studio_canvas_context.md",
            kind: "tool-description",
            tool: "game_studio_canvas_context",
            chars: 496,
          },
        ],
      },
    ],
  }),
  file: () => ({ content: toolDescription, placeholders: [], maxChars: 4096 }),
};
const meta = {
  beforeEach: () => clearDraftsForTest(),
  play: ready,
  title: "Screens/Prompt Editor/Tools and files",
  component: RegisteredSurface,
  args: { source, select: (app) => nav(app, "", "plugins") },
  parameters: {
    ...screenParameters,
    editorContext: { placement: "page-panel", title: "Prompt Editor", tab: "Plugins" },
    host: { pluginId: "prompt-editor", rpc },
  },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ToolBrowser: Story = { play: shows("Code Review") };
export const FileEditor: Story = {
  parameters: { editorContext: { placement: "page", title: "Prompt Editor" } },
  args: {
    select: (app) => nav(app, "code-review/file/instructions/tools/code_review_share_changes.md"),
  },
};
export const NoSelection: Story = {
  parameters: { editorContext: { placement: "page", title: "Prompt Editor" } },
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
