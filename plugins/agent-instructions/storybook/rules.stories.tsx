import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, within } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { RegisteredSurface } from "../../../.storybook/host";
import { settings } from "../../../.storybook/surfaces";
import { RuleCard } from "../src/app/app";
const source = () => import("../src/app/app");
const targets = {
  hosts: [{ id: "host_local", name: "Workstation" }],
  providers: [
    { id: "codex", name: "Codex" },
    { id: "claude-code", name: "Claude Code" },
  ],
  projects: [{ id: "proj_story", name: "bb-plugins" }],
};
function EditableRule(args: ComponentProps<typeof RuleCard>) {
  const [rule, setRule] = useState(args.rule);
  return (
    <RuleCard
      {...args}
      rule={rule}
      onChange={(next) => {
        setRule(next);
        args.onChange(next);
      }}
    />
  );
}
const meta = {
  title: "Plugins/Agent Instructions/Rules editor",
  component: RuleCard,
  tags: ["autodocs"],
  play: ready,
  render: (args) => <EditableRule {...args} />,
  args: {
    rule: {
      id: "rule_style",
      name: "Review guidance",
      enabled: true,
      instructions: "Inspect changed code and verify observable behavior.",
      when: { hosts: [], providers: [], projects: [], models: [] },
    },
    targets,
    initiallyOpen: false,
    onChange: fn(),
    onDelete: fn(),
  },
} satisfies Meta<typeof RuleCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {};
export const Blank: Story = { args: { rule: { ...meta.args.rule, name: "", instructions: "" } } };
export const Disabled: Story = { args: { rule: { ...meta.args.rule, enabled: false } } };
export const Scoped: Story = {
  args: {
    initiallyOpen: true,
    rule: {
      ...meta.args.rule,
      when: { hosts: ["host_local"], providers: ["codex"], projects: [], models: ["gpt-*"] },
    },
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
