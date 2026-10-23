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
      { path: "src/app.tsx", status: "modified", additions: 24, deletions: 7 },
      { path: "src/components/filter.tsx", status: "added", additions: 68, deletions: 0 },
      { path: "assets/logo.png", status: "modified", additions: null, deletions: null },
      { path: "src/legacy.ts", status: "deleted", additions: 0, deletions: 35 },
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
        path: "packages/workspace/components/deeply/nested/folder/a-long-component-name.tsx",
        status: "renamed",
        additions: 2,
        deletions: 2,
      },
    ],
  },
};
