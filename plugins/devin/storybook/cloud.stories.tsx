import { shows } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { banner } from "../../../.storybook/surfaces";
const source = () => import("../src/app/app");
const meta = {
  play: shows("Open in Devin"),
  title: "Plugins/Devin/Cloud session",
  component: RegisteredSurface,
  args: { source, select: (app) => banner(app, "cloud-session") },
  parameters: {
    host: {
      pluginId: "devin",
      context: { threadId: "thr_story" },
      composer: { scope: { kind: "thread", threadId: "thr_story" } },
      rpc: {
        cloudSession: () => ({
          state: "active",
          sessionId: "devin-preview",
          url: "https://app.devin.ai/sessions/preview",
          attachCommand: "devin --cloud -r devin-preview",
        }),
      },
      sdk: { subscribe: () => () => {} },
    },
  },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Active: Story = {};
export const Starting: Story = {
  play: shows("Starting a cloud session…"),
  parameters: {
    host: {
      pluginId: "devin",
      context: { threadId: "thr_story" },
      composer: { scope: { kind: "thread", threadId: "thr_story" } },
      rpc: { cloudSession: () => ({ state: "starting" }) },
      sdk: { subscribe: () => () => {} },
    },
  },
};
