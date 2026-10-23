import { screenParameters } from "../../../.storybook/layout";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { shows } from "../../../.storybook/ready";
import { OperationHistory } from "../src/app/history-screen";
import "../src/app/gitbutler.css";
const target = { threadId: "thr_story", repositoryKey: "." };
const meta = {
  title: "Screens/GitButler/Operation history",
  component: OperationHistory,
  args: { target },
  parameters: {
    ...screenParameters,
    host: {
      pluginId: "gitbutler",
      rpc: {
        oplog: () => ({
          entries: [
            {
              id: "aabbccddee",
              operation: "CreateCommit",
              title: "CreateCommit",
              body: "Document plugin components",
              createdAt: "2026-10-22T12:00:00Z",
            },
          ],
          reason: null,
        }),
      },
    },
  },
} satisfies Meta<typeof OperationHistory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const History: Story = {
  render: () => <OperationHistory target={target} />,
  play: shows("Create commit"),
};
export const EmptyHistory: Story = {
  render: () => <OperationHistory target={target} />,
  parameters: { host: { rpc: { oplog: () => ({ entries: [], reason: null }) } } },
  play: shows("No operations yet"),
};
export const OfflineHistory: Story = {
  render: () => <OperationHistory target={target} />,
  parameters: {
    host: { rpc: { oplog: () => Promise.reject(new Error("Checkout host is offline")) } },
  },
  play: shows("History failed to load"),
};
