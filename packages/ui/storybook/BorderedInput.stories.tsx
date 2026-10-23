import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { BorderedInput } from "../src/input";

const meta = {
  title: "Shared/BorderedInput",
  component: BorderedInput,
  args: { "aria-label": "Repository", placeholder: "Repository path", onChange: fn() },
  argTypes: {
    type: {
      control: "select",
      options: ["text", "email", "password", "search", "number", "tel", "url"],
    },
    disabled: { control: "boolean" },
    readOnly: { control: "boolean" },
    defaultValue: { control: "text" },
  },
  tags: ["autodocs"],
} satisfies Meta<typeof BorderedInput>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true, defaultValue: "/workspace/project" } };

export const Surface: Story = {
  name: "(Test) Repository surface",
  play: async ({ canvasElement }) => {
    const style = getComputedStyle(within(canvasElement).getByRole("textbox"));
    await expect(style.backgroundColor).toBe("rgb(21, 21, 21)");
    await expect(style.borderColor).toBe("rgba(227, 227, 221, 0.12)");
  },
};
