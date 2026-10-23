import { screenParameters } from "../../../.storybook/layout";
import { shows } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { nav } from "../../../.storybook/surfaces";
const source = () => import("../src/app/app");
const reminders = [
  {
    id: "b6ebea6a-0d32-4e3a-9eba-789126676318",
    title: "Try the reduced-motion command menu on a phone",
    body: "Use the 360px layout with a hardware keyboard. Check that Escape restores focus to the trigger and the search query survives reopening.",
    sourceThreadId: "thr_accessibility",
    createdAt: "2026-10-23T09:20:00Z",
  },
  {
    id: "c3ebea6a-0d32-4e3a-9eba-789126676318",
    title: "Recheck the reconnect fix after the staging soak",
    body: "Leave the review open while the Ubuntu host disconnects. After reconnect, confirm the selected file, scroll position, and unsent comment are unchanged.",
    sourceThreadId: "thr_story",
    createdAt: "2026-10-22T12:00:00Z",
  },
  {
    id: "a1ebea6a-0d32-4e3a-9eba-789126676318",
    title: "Send the migration checklist to the release owner",
    body: "The API migration is ready for staging. Confirm the rollback command and attach the latest backup timestamp before the production window.",
    sourceThreadId: null,
    createdAt: "2026-10-22T13:00:00Z",
  },
];
const meta = {
  play: shows("Recheck the reconnect fix after the staging soak"),
  title: "Screens/Reminders/Saved reminders",
  component: RegisteredSurface,
  args: { source, select: nav },
  parameters: {
    ...screenParameters,
    host: { pluginId: "remind-me", rpc: { list: () => ({ reminders }) } },
  },
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
