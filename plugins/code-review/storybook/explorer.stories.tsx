import { reviewFiles } from "../../../.storybook/fixtures";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { FileExplorer } from "../src/app/file-explorer";
const meta = {
  title: "Components/Code Review/File explorer",
  component: FileExplorer,
  // The virtualized tree needs a viewport; the surrounding preview stays content-sized.
  decorators: [
    (Story) => (
      <div className="flex h-64 flex-col">
        <Story />
      </div>
    ),
  ],
  tags: ["autodocs"],
  play: ready,
  args: {
    files: reviewFiles.map(({ path, status, additions, deletions }) => ({
      path,
      additions,
      deletions,
      status: status === "deleted" ? "removed" : status,
    })),
    current: "src/reviews/use-review-query.ts",
    onSelect: fn(),
  },
} satisfies Meta<typeof FileExplorer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Files: Story = {};
export const Empty: Story = { args: { files: [], current: null } };
export const Filtered: Story = {
  args: {
    files: meta.args.files.filter((file) => file.path === "src/reviews/use-review-query.ts"),
    filtering: true,
  },
};
export const WithComments: Story = {
  args: { threadsByPath: new Map([["src/reviews/use-review-query.ts", 3]]) },
};
