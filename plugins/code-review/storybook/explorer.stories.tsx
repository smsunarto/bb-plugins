import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { FileExplorer } from "../src/app/file-explorer";
const meta = {
  title: "Plugins/Code Review/File explorer",
  component: FileExplorer,
  tags: ["autodocs"],
  play: ready,
  args: {
    files: [
      { path: "src/app.tsx", status: "modified", additions: 12, deletions: 3 },
      { path: "src/components/button.tsx", status: "added", additions: 42, deletions: 0 },
      { path: "README.md", status: "modified", additions: 4, deletions: 0 },
    ],
    current: "src/app.tsx",
    onSelect: fn(),
  },
} satisfies Meta<typeof FileExplorer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Files: Story = {};
export const Empty: Story = { args: { files: [], current: null } };
export const Filtered: Story = {
  args: { files: meta.args.files.filter((file) => file.path === "src/app.tsx"), filtering: true },
};
export const WithComments: Story = { args: { threadsByPath: new Map([["src/app.tsx", 3]]) } };
