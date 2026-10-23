import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { FileList, Count, LineStats } from "../src/app/file-list";
import { Notice, WorkspaceSkeleton, CommitRowsSkeleton, FileRowsSkeleton } from "../src/app/notice";
const meta = {
  play: ready,
  title: "Plugins/GitButler/Changed files",
  component: FileList,
  tags: ["autodocs"],
  args: {
    mode: "list",
    onSelect: fn(),
    changes: [
      { path: "src/components/button.tsx", kind: "modified" },
      { path: "src/new-file.ts", kind: "added" },
      { path: "src/legacy.ts", kind: "deleted" },
      { path: "assets/icon.svg", kind: "renamed" },
    ],
  },
} satisfies Meta<typeof FileList>;
export default meta;
type Story = StoryObj<typeof meta>;
export const List: Story = {};
export const Tree: Story = { args: { mode: "tree" } };
export const Selected: Story = { args: { active: "src/components/button.tsx" } };
export const Empty: Story = { args: { changes: [] } };
export const Statistics: Story = {
  render: () => (
    <div className="sb-gallery">
      <Count>{12}</Count>
      <LineStats added={124} removed={31} />
      <LineStats added={0} removed={9} />
    </div>
  ),
};
export const Offline: Story = {
  render: () => (
    <Notice
      title="Checkout host is offline"
      detail="Your last loaded changes remain available."
      onRetry={fn()}
    />
  ),
};
export const WorkspaceLoading: Story = {
  render: () => <WorkspaceSkeleton label="Loading workspace" />,
};
export const CommitsLoading: Story = {
  render: () => <CommitRowsSkeleton label="Loading commits" />,
};
export const FilesLoading: Story = { render: () => <FileRowsSkeleton label="Loading files" /> };
