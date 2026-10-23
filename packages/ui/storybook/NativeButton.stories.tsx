import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { NativeButton } from "../src/button";

const variants = ["default", "secondary", "outline", "ghost", "destructive", "link"] as const;
const sizes = ["sm", "default", "lg", "icon"] as const;

const meta = {
  title: "Shared/NativeButton",
  component: NativeButton,
  args: { children: "Workspace action", variant: "outline", onClick: fn() },
  argTypes: {
    variant: { control: "select", options: variants },
    size: { control: "select", options: sizes },
  },
  tags: ["autodocs"],
} satisfies Meta<typeof NativeButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };

export const Focus: Story = {
  name: "(Test) Keyboard focus",
  play: async ({ canvasElement }) => {
    await userEvent.tab();
    await expect(within(canvasElement).getByRole("button")).toHaveFocus();
  },
};
export const IconSize: Story = {
  name: "(Test) Explicit icon size",
  args: {
    children: (
      <svg data-testid="sized-icon" className="size-7" viewBox="0 0 24 24">
        <path d="M4 12h16" />
      </svg>
    ),
    "aria-label": "Sized icon",
  },
  play: async ({ canvasElement }) => {
    await expect(getComputedStyle(within(canvasElement).getByTestId("sized-icon")).width).toBe(
      "28px",
    );
  },
};
