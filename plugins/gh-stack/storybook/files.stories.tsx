import { reviewFiles } from "../../../.storybook/fixtures";
import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChangedFileTree } from "../components/stack/changed-file-tree";
import "../app.css";
const meta = {
  play: ready,
  title: "Components/GitHub Stack/Changed files",
  component: ChangedFileTree,
  tags: ["autodocs"],
  args: {
    files: [
      ...reviewFiles,
      { path: "docs/reviews/offline-panel.png", status: "added", additions: null, deletions: null },
    ],
  },
} satisfies Meta<typeof ChangedFileTree>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MixedChanges: Story = {};
export const Empty: Story = { args: { files: [] } };
export const LongPaths: Story = {
  args: {
    files: [
      {
        path: "packages/workspace/src/reviews/components/reconnection/review-connection-status.tsx",
        status: "renamed",
        additions: 2,
        deletions: 2,
      },
    ],
  },
};
