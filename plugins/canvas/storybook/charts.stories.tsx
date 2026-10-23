import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { BarChart, LineChart, PieChart, UsageBar } from "../src/app/charts";
import "../src/app/app.css";
const meta = {
  play: ready,
  title: "Components/Canvas/Charts",
  component: BarChart,
  tags: ["autodocs"],
  args: {
    title: "Review refreshes · last five weekdays",
    categories: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    series: [
      { name: "Accepted", data: [186, 224, 208, 271, 243], tone: "success" },
      { name: "Retried", data: [9, 12, 6, 18, 8], tone: "warning" },
    ],
  },
} satisfies Meta<typeof BarChart>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Bars: Story = {};
export const Stacked: Story = { args: { stacked: true } };
export const Horizontal: Story = { args: { horizontal: true } };
export const Empty: Story = { args: { categories: [], series: [] } };
export const NegativeValues: Story = {
  args: {
    title: "Weekly change in open release issues",
    categories: ["Web", "API", "Workers"],
    series: [{ name: "Net issues", data: [-12, 0, 7] }],
  },
};
export const Reference: Story = {
  args: { referenceLines: [{ value: 250, label: "Daily capacity", tone: "info" }] },
};
export const Lines: Story = { render: (args) => <LineChart {...args} /> };
export const Pie: Story = {
  render: () => (
    <PieChart
      title="Release checks"
      data={[
        { label: "Passed", value: 18, tone: "success" },
        { label: "Awaiting review", value: 3, tone: "warning" },
        { label: "Blocked", value: 1, tone: "danger" },
      ]}
    />
  ),
};
export const Usage: Story = {
  render: () => (
    <UsageBar
      total={100}
      segments={[{ label: "Build minutes", value: 68, tone: "info" }]}
      labels={{ left: "Build budget", right: "68 of 100 minutes" }}
    />
  ),
};
export const FullUsage: Story = {
  render: () => <UsageBar total={100} segments={[{ label: "Used", value: 100, tone: "danger" }]} />,
};
