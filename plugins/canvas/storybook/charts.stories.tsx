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
    title: "Requests by day",
    categories: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    series: [
      { name: "Accepted", data: [12, 24, 18, 31, 27], tone: "success" },
      { name: "Retried", data: [3, 5, 2, 8, 4], tone: "warning" },
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
  args: { categories: ["A", "B", "C"], series: [{ name: "Change", data: [-12, 0, 18] }] },
};
export const Reference: Story = {
  args: { referenceLines: [{ value: 25, label: "Target", tone: "info" }] },
};
export const Lines: Story = { render: (args) => <LineChart {...args} /> };
export const Pie: Story = {
  render: () => (
    <PieChart
      title="Task outcomes"
      data={[
        { label: "Complete", value: 24, tone: "success" },
        { label: "Pending", value: 8, tone: "warning" },
        { label: "Failed", value: 3, tone: "danger" },
      ]}
    />
  ),
};
export const Usage: Story = {
  render: () => (
    <UsageBar
      total={100}
      segments={[{ label: "Used", value: 68, tone: "info" }]}
      labels={{ left: "Monthly quota", right: "68 of 100" }}
    />
  ),
};
export const FullUsage: Story = {
  render: () => <UsageBar total={100} segments={[{ label: "Used", value: 100, tone: "danger" }]} />,
};
