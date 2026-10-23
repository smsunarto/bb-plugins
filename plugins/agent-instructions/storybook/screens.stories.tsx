import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { RegisteredSurface } from "../../../.storybook/host";
import { settings } from "../../../.storybook/surfaces";
const source = () => import("../src/app/app");
const targets = {
  hosts: [{ id: "host_local", name: "Workstation" }],
  providers: [
    { id: "codex", name: "Codex" },
    { id: "claude-code", name: "Claude Code" },
  ],
  projects: [{ id: "proj_story", name: "bb-plugins" }],
};
const meta = {
  title: "Screens/Agent Instructions/Rules editor",
  component: RegisteredSurface,
  args: { source, select: settings },
  play: ready,
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Loading: Story = {
  render: () => <RegisteredSurface source={source} select={settings} />,
  parameters: {
    host: {
      pluginId: "agent-instructions",
      rpc: { rules: () => new Promise(() => {}), targets: () => targets },
    },
  },
  play: async (context) => {
    await ready(context);
    await within(context.canvasElement).findByText("Loading…");
  },
};
export const Error: Story = {
  render: () => <RegisteredSurface source={source} select={settings} />,
  parameters: {
    host: {
      pluginId: "agent-instructions",
      rpc: {
        rules: () => Promise.reject(new globalThis.Error("Could not load instructions")),
        targets: () => targets,
      },
    },
  },
  play: async (context) => {
    await ready(context);
    await within(context.canvasElement).findByText("Could not load instructions");
  },
};
