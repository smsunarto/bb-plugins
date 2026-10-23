import { recoveryPlan } from "../../../.storybook/fixtures";
import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentMarkdown } from "../src/app/markdown/agent-markdown";
import { EmptyState } from "../src/app/panel/empty-state";
import "../src/app/styles/index.css";
const meta = {
  play: ready,
  title: "Components/Whiteboard/Markdown",
  component: AgentMarkdown,
  tags: ["autodocs"],
  args: {
    source: recoveryPlan,
  },
} satisfies Meta<typeof AgentMarkdown>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Prose: Story = {};
export const Code: Story = {
  args: {
    source:
      "```typescript\nasync function refreshReview(checkoutKey: string) {\n  const snapshot = await loadReview(checkoutKey);\n  if (selectedCheckout.current !== checkoutKey) return;\n  cache.set(checkoutKey, snapshot);\n}\n```",
  },
};
export const Empty: Story = {
  render: () => (
    <EmptyState title="No Whiteboards yet" description="Create a review to explain a change." />
  ),
};
export const Unavailable: Story = {
  render: () => (
    <EmptyState
      title="Whiteboard is unavailable"
      description="Reconnect the owning host to continue."
    />
  ),
};
