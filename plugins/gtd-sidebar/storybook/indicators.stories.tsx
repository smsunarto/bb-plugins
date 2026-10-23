import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusGlyph } from "../components/inbox/status-glyph";
import "../app.css";
const meta = {
  play: ready,
  title: "Components/GTD Sidebar/Status indicators",
  component: StatusGlyph,
  tags: ["autodocs"],
  args: { indicator: "runtime", label: "Working" },
} satisfies Meta<typeof StatusGlyph>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Working: Story = {};
export const Failed: Story = { args: { indicator: "unread-error", label: "Turn failed" } };
export const Waiting: Story = {
  args: { indicator: "waiting-for-input", label: "Needs your input" },
};
export const AllIndicators: Story = {
  render: () => (
    <div className="sb-stack">
      {(
        [
          "unread-error",
          "queued-failed",
          "queued-waiting",
          "waiting-for-input",
          "unread-success",
          "runtime",
          "workflow",
          "background-agent",
          "background-command",
          "plan-mode",
          "goal",
          "draft",
          "working-draft",
          "none",
        ] as const
      ).map((indicator) => (
        <div className="sb-gallery" key={indicator}>
          <StatusGlyph indicator={indicator} label={indicator} />
          <span>{indicator}</span>
        </div>
      ))}
    </div>
  ),
};
