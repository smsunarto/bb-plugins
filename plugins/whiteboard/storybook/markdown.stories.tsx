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
    source:
      "# Review notes\n\nA **clear outcome**, with `inline code` and a [reference](https://example.com).\n\n- Preserve the selected checkout\n- Retry only safe reads\n\n> Cached state remains visible during reconnect.\n\n| State | Result |\n| --- | --- |\n| Ready | Available |\n| Offline | Cached |",
  },
} satisfies Meta<typeof AgentMarkdown>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Prose: Story = {};
export const Code: Story = {
  args: {
    source: "```typescript\nexport function sum(a: number, b: number) {\n  return a + b;\n}\n```",
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
