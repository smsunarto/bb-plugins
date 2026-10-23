import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { QuickShareCard } from "../src/app/shares";
import "../src/app/cloudflare.css";
const meta = {
  title: "Components/Cloudflare/Quick shares",
  component: QuickShareCard,
  tags: ["autodocs"],
  play: ready,
  args: {
    share: {
      id: "storybook",
      label: "Atlas · release review",
      hostId: "host_local",
      port: 6010,
      state: "running",
      url: "https://atlas-release-review.trycloudflare.com",
      createdAt: "2026-10-22T12:00:00Z",
      updatedAt: "2026-10-22T12:00:00Z",
    },
    hosts: [{ id: "host_local", name: "Design MacBook", online: true }],
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
    share: {
      ...meta.args.share,
      state: "error",
      lastError:
        "The local server on port 6010 stopped responding. Restart it, then start this share again.",
    },
  },
};
export const HostOffline: Story = {
  args: { hosts: [{ id: "host_local", name: "Design MacBook", online: false }] },
};
export const Working: Story = { args: { busy: true } };
