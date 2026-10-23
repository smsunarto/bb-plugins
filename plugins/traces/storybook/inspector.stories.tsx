import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { JsonView } from "../src/app/json-view";
import { Empty, QueryError, Pages } from "../src/app/controls";
import "../src/app/traces.css";
const meta = {
  play: ready,
  title: "Components/Traces/Inspector",
  component: JsonView,
  tags: ["autodocs"],
  args: {
    value: {
      provider: "codex",
      status: "complete",
      usage: { input: 1240, output: 325 },
      tools: [{ name: "read_file", ok: true }],
      error: null,
    },
  },
} satisfies Meta<typeof JsonView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Structured: Story = {};
export const LongText: Story = { args: { value: { message: "Detailed output. ".repeat(200) } } };
export const ManyKeys: Story = {
  args: { value: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`event_${i}`, i])) },
};
export const NoSession: Story = {
  render: () => (
    <Empty title="No matching sessions">Try a different filter or check Sources.</Empty>
  ),
};
export const Unavailable: Story = {
  render: () => (
    <QueryError error={new globalThis.Error("The trace host is offline")} retry={fn()} />
  ),
};
export const Pagination: Story = {
  render: () => <Pages page={2} loading={false} hasNext onPrevious={fn()} onNext={fn()} />,
};
