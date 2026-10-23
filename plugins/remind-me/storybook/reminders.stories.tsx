import { shows } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { nav } from "../../../.storybook/surfaces";
const source = () => import("../src/app/app");
const reminders = [
  {
    id: "c3ebea6a-0d32-4e3a-9eba-789126676318",
    title: "Review the component catalog",
    body: "Check keyboard navigation and narrow panel layouts before shipping.",
    sourceThreadId: "thr_story",
    createdAt: "2026-10-22T12:00:00Z",
  },
  {
    id: "a1ebea6a-0d32-4e3a-9eba-789126676318",
    title: "Update release notes",
    body: "Document the new plugin UI states.",
    sourceThreadId: null,
    createdAt: "2026-10-22T13:00:00Z",
  },
];
const meta = {
  play: shows("Review the component catalog"),
  title: "Screens/Reminders/Saved reminders",
  component: RegisteredSurface,
  args: { source, select: nav },
  parameters: { host: { pluginId: "remind-me", rpc: { list: () => ({ reminders }) } } },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {};
export const Empty: Story = {
  play: shows(/Nothing saved yet/),
  parameters: { host: { pluginId: "remind-me", rpc: { list: () => ({ reminders: [] }) } } },
};
export const Loading: Story = {
  play: shows("Loading reminders…"),
  parameters: { host: { pluginId: "remind-me", rpc: { list: () => new Promise(() => {}) } } },
};
export const Error: Story = {
  play: shows(/Could not load reminders/),
  parameters: {
    host: {
      pluginId: "remind-me",
      rpc: { list: () => Promise.reject(new globalThis.Error("Cannot read saved reminders")) },
    },
  },
};
