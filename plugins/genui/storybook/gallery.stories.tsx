import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { userEvent } from "vitest/browser";
import { RegisteredSurface } from "../../../.storybook/host";
import { nav } from "../../../.storybook/surfaces";

const source = () => import("../app");
const spec = `$monthly = 1200
$months = 6
Card("Savings goal", [
  Slider($monthly, 100, 5000, 100, label: "Monthly saving ($)"),
  Slider($months, 1, 24, label: "Months"),
  Metric("You'll have", "$" + fmt($monthly * $months), tone: "good")
])`;

const meta = {
  title: "Screens/GenUI/Gallery",
  component: RegisteredSurface,
  args: { source, select: (app) => nav(app, "Slider") },
  parameters: {
    host: {
      pluginId: "genui",
      settings: { animations: false, webLookups: false },
      rpc: {
        gallery_list: () => ({ names: ["Slider.ui"] }),
        gallery_get: () => ({ source: spec }),
      },
    },
  },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SavingsGoal: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const months = await canvas.findByRole("slider", { name: "Months" }, { timeout: 15000 });
    await expect(canvas.getByText("$7,200")).toBeVisible();
    months.focus();
    await userEvent.keyboard("{End}");
    await expect(canvas.getByText("$28,800")).toBeVisible();
    await userEvent.keyboard("{Home}");
    await expect(canvas.getByText("$1,200")).toBeVisible();
  },
};
