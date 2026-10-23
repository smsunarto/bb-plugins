import { isolatedParameters } from "../../../.storybook/layout";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { FindingCard } from "../src/app/finding";
const meta = {
  parameters: isolatedParameters,
  title: "Components/Code Review/Findings",
  component: FindingCard,
  tags: ["autodocs"],
  play: ready,
  args: {
    finding: {
      id: "finding_story",
      priority: 1,
      title: "Preserve the selected checkout",
      body: "A late response from the previous checkout can replace the active result.",
      path: "src/selection.ts",
      line: 24,
      startLine: 21,
      side: "RIGHT",
    },
    stale: false,
    onReveal: fn(),
    pr: null,
  },
} satisfies Meta<typeof FindingCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Urgent: Story = {};
export const Normal: Story = { args: { finding: { ...meta.args.finding, priority: 2 } } };
export const Low: Story = { args: { finding: { ...meta.args.finding, priority: 3 } } };
export const Stale: Story = { args: { stale: true } };
