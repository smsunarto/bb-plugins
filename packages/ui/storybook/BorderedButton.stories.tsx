import type { CSSProperties } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { BorderedButton } from "../src/button";

const variants = ["default", "secondary", "outline", "ghost", "destructive", "link"] as const;
const sizes = ["sm", "default", "lg", "icon"] as const;

const meta = {
  title: "Components/Shared/BorderedButton",
  component: BorderedButton,
  args: { children: "Repository action", variant: "outline", onClick: fn() },
  argTypes: {
    variant: { control: "select", options: variants },
    size: { control: "select", options: sizes },
  },
  tags: ["autodocs"],
} satisfies Meta<typeof BorderedButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };

export const Border: Story = {
  name: "(Test) Repository border",
  render: (args) => {
    const tokens: CSSProperties & { "--input": string } = { "--input": "var(--destructive)" };
    return (
      <div style={tokens}>
        <BorderedButton {...args} />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const style = getComputedStyle(within(canvasElement).getByRole("button"));
    await expect(style.borderWidth).toBe("1px");
    await expect(style.borderColor).toBe("rgba(227, 227, 221, 0.12)");
  },
};
