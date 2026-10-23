import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { RuleCard } from "../src/app/app";
const targets = {
  hosts: [{ id: "host_local", name: "Design MacBook" }],
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
  title: "Components/Agent Instructions/Rule card",
  component: RuleCard,
  tags: ["autodocs"],
  play: ready,
  render: (args) => <EditableRule {...args} />,
  args: {
    rule: {
      id: "rule_style",
      name: "Review network and cache changes",
      enabled: true,
      instructions:
        "When a change touches network requests or cached data, trace the disconnect and reconnect paths. Preserve useful cached content, reject responses for a superseded selection, and include a reproduction for any race condition you find.",
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
