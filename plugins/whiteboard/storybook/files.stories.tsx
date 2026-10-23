import { reviewFiles } from "../../../.storybook/fixtures";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { DiffFileTree } from "../src/app/bridge/diff-file-tree";
const files = reviewFiles;
const meta = {
  title: "Components/Whiteboard/Diff file tree",
  component: DiffFileTree,
  tags: ["autodocs"],
  play: ready,
  args: {
    files,
    showFileCounts: true,
    activePath: "src/reviews/use-review-query.ts",
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
        path: "docs/reviews/offline-recovery.md",
        previousPath: "docs/reviews/retry.md",
        status: "renamed",
        additions: 1,
        deletions: 1,
      },
    ],
  },
};
