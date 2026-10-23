import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { DiffFileTree } from "../src/app/bridge/diff-file-tree";
const files = [
  { path: "src/app.tsx", status: "modified", additions: 24, deletions: 8 },
  { path: "src/components/button.tsx", status: "added", additions: 48, deletions: 0 },
  { path: "src/legacy.ts", status: "deleted", additions: 0, deletions: 16 },
] as const;
const meta = {
  title: "Components/Whiteboard/Diff file tree",
  component: DiffFileTree,
  tags: ["autodocs"],
  play: ready,
  args: {
    files,
    showFileCounts: true,
    activePath: "src/app.tsx",
    onReveal: fn(),
    onToggleViewed: fn(),
  },
} satisfies Meta<typeof DiffFileTree>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Files: Story = {};
export const Empty: Story = { args: { files: [] } };
export const Rename: Story = {
  args: {
    files: [
      {
        path: "src/renamed.ts",
        previousPath: "src/original.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
      },
    ],
  },
};
