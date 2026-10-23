import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { VerdictBadge } from "../src/app/review";
import "../src/app/studio.css";
import "../src/app/canvas.css";
const meta = {
  play: ready,
  title: "Components/Game Studio/Asset verdict",
  component: VerdictBadge,
  tags: ["autodocs"],
  args: { verdict: "pass", className: "gs-verdict" },
} satisfies Meta<typeof VerdictBadge>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Passed: Story = {};
export const NeedsFixes: Story = { args: { verdict: "fixes" } };
export const Failed: Story = { args: { verdict: "fail" } };
export const Reviewing: Story = { args: { reviewing: true } };
