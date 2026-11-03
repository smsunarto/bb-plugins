import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { nav } from "../../../.storybook/surfaces";
import { shows } from "../../../.storybook/ready";

const source = () => import("../src/app/app");
const configPath = "/home/scott/.config/bb-grokbot/config.json";
const entries = [
  {
    id: "e2",
    ts: "2026-11-02T10:04:00.000Z",
    action: "message",
    target_bot: "research",
    textPreview: "Summarize the open review comments on this branch.",
    context: { thread_id: "thr_1", project: "bb-plugins", branch: "scott/grokbot" },
    ok: true,
    status: 200,
    error: null,
    durationMs: 184,
  },
  {
    id: "e1",
    ts: "2026-11-02T10:01:00.000Z",
    action: "ping",
    target_bot: null,
    textPreview: "ping",
    context: null,
    ok: false,
    status: null,
    error: "Timed out after 8s",
    durationMs: 8003,
  },
];

const meta = {
  title: "Screens/Grok Bot/Panel",
  component: RegisteredSurface,
  args: { source, select: (app) => nav(app) },
  play: shows("Recent sends"),
  parameters: {
    host: {
      pluginId: "grokbot",
      rpc: {
        status: () => ({
          state: "ready",
          configPath,
          bots: [
            { id: "research", name: "Research bot" },
            { id: "ops", name: "Ops bot" },
          ],
        }),
        log: () => ({ entries }),
      },
    },
  },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Configured: Story = {};

export const NotConfigured: Story = {
  play: shows("Not configured"),
  parameters: {
    host: {
      pluginId: "grokbot",
      rpc: {
        status: () => ({
          state: "missing",
          configPath,
          reason: `No config file at ${configPath}.`,
        }),
        log: () => ({ entries: [] }),
      },
    },
  },
};
