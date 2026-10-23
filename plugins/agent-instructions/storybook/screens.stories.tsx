import { screenParameters } from "../../../.storybook/layout";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { RegisteredSurface } from "../../../.storybook/host";
import { settings } from "../../../.storybook/surfaces";
import { resetRulesDraftForTest } from "../src/app/app";
import type { RulesState } from "../src/shared/rules";
const source = () => import("../src/app/app");
const targets = {
  hosts: [{ id: "host_local", name: "Design MacBook" }],
  providers: [
    { id: "codex", name: "Codex" },
    { id: "claude-code", name: "Claude Code" },
  ],
  projects: [{ id: "proj_story", name: "bb-plugins" }],
};
const initialRules: RulesState = {
  revision: 1,
  rules: [
    {
      id: "review-network",
      name: "Review network and cache changes",
      enabled: true,
      instructions:
        "Trace disconnect and reconnect behavior. Keep useful cached data visible and reject late responses for superseded selections. Include a reproduction for any race condition.",
      when: { hosts: [], providers: [], projects: [], models: [] },
    },
    {
      id: "release-checks",
      name: "Before release",
      enabled: true,
      instructions:
        "Run the affected tests and the production build. Report which checks passed and any platform you could not verify. Keep unrelated working-tree changes out of the commit.",
      when: { hosts: [], providers: ["codex"], projects: ["proj_story"], models: [] },
    },
    {
      id: "old-format",
      name: "Legacy changelog format",
      enabled: false,
      instructions: "Use the old changelog template for archived releases only.",
      when: { hosts: [], providers: [], projects: [], models: [] },
    },
  ],
};
let storedRules = structuredClone(initialRules);
const meta = {
  beforeEach: () => {
    resetRulesDraftForTest();
    storedRules = structuredClone(initialRules);
  },
  parameters: screenParameters,
  title: "Screens/Agent Instructions/Rules editor",
  component: RegisteredSurface,
  args: { source, select: settings },
  play: ready,
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {
  parameters: {
    host: {
      pluginId: "agent-instructions",
      rpc: {
        rules: () => storedRules,
        targets: () => targets,
        saveRules: (input: RulesState) => {
          if (input.revision !== storedRules.revision) return { ...storedRules, saved: false };
          storedRules = { rules: input.rules, revision: storedRules.revision + 1 };
          return { ...storedRules, saved: true };
        },
      },
    },
  },
  play: async (context) => {
    await ready(context);
    await within(context.canvasElement).findByDisplayValue("Review network and cache changes");
  },
};
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
