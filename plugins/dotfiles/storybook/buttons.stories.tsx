import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { Button } from "./../src/app/components/ui/button";
const clicked = fn();
const meta = {
  render: (args) => <Button {...args} onClick={() => clicked()} />,
  play: ready,
  title: "Plugins/Dotfiles/Buttons",
  component: Button,
  tags: ["autodocs"],
  args: { children: "Continue", onClick: clicked },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("button", { name: "Continue" }));
    await expect(args.onClick).toHaveBeenCalled();
  },
};
export const Disabled: Story = { args: { disabled: true } };
export const LongLabel: Story = {
  args: { children: "Review all changes in this checkout before continuing" },
};
export const Variants: Story = {
  render: () => (
    <div className="sb-gallery">
      {(["default", "destructive", "outline", "secondary", "ghost", "link"] as const).map(
        (variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ),
      )}
    </div>
  ),
};
