import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { SyncState } from "../src/app/sync-state";
const query = {
  dataUpdatedAt: Date.now() - 120000,
  isFetching: false,
  isError: false,
  error: null,
  refetch: fn(),
};
const meta = {
  title: "Components/Code Review/Refresh status",
  component: SyncState,
  tags: ["autodocs"],
  play: ready,
  args: { query },
} satisfies Meta<typeof SyncState>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Cached: Story = {};
export const Refreshing: Story = { args: { query: { ...query, isFetching: true } } };
export const Offline: Story = {
  args: { query: { ...query, isError: true, error: new Error("Host unavailable") } },
};
