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
              id: "9c804bc37f",
              operation: "CreateCommit",
              title: "CreateCommit",
              body: "fix(reviews): keep cached files visible during reconnect",
              createdAt: "2026-10-23T10:40:00Z",
            },
            {
              id: "7b20a1f933",
              operation: "AmendCommit",
              title: "AmendCommit",
              body: "Add deferred-response coverage for checkout switching",
              createdAt: "2026-10-23T10:32:00Z",
            },
            {
              id: "50fb24e7c1",
              operation: "CreateBranch",
              title: "CreateBranch",
              body: "maya/offline-review-recovery",
              createdAt: "2026-10-23T09:18:00Z",
            },
            {
              id: "32cf980a11",
              operation: "CreateCommit",
              title: "CreateCommit",
              body: "feat(reviews): store snapshots by checkout and revision",
              createdAt: "2026-10-22T16:20:00Z",
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
  play: shows("fix(reviews): keep cached files visible during reconnect"),
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
