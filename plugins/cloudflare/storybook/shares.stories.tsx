import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { QuickShareCard } from "../src/app/shares";
import "../src/app/cloudflare.css";
const meta = {
  title: "Plugins/Cloudflare/Quick shares",
  component: QuickShareCard,
  tags: ["autodocs"],
  play: ready,
  args: {
    share: {
      id: "storybook",
      label: "Component preview",
      hostId: "host_local",
      port: 6010,
      state: "running",
      url: "https://preview.example.com",
      createdAt: "2026-10-22T12:00:00Z",
      updatedAt: "2026-10-22T12:00:00Z",
    },
    hosts: [{ id: "host_local", name: "Workstation", online: true }],
    busy: false,
    onAction: fn(),
  },
} satisfies Meta<typeof QuickShareCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Running: Story = {};
export const Stopped: Story = { args: { share: { ...meta.args.share, state: "stopped" } } };
export const Failed: Story = {
  args: {
    share: { ...meta.args.share, state: "error", lastError: "Tunnel connector disconnected" },
  },
};
export const HostOffline: Story = {
  args: { hosts: [{ id: "host_local", name: "Workstation", online: false }] },
};
export const Working: Story = { args: { busy: true } };
