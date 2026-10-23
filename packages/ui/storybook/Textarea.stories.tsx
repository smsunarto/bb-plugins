import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { Textarea } from "../src/textarea";

const meta = {
  title: "Shared/Textarea",
  component: Textarea,
  args: { "aria-label": "Description", placeholder: "Describe this component", onChange: fn() },
  argTypes: {
    rows: { control: { type: "number", min: 1 } },
    disabled: { control: "boolean" },
    readOnly: { control: "boolean" },
    defaultValue: { control: "text" },
  },
  tags: ["autodocs"],
} satisfies Meta<typeof Textarea>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true, defaultValue: "Unavailable" } };
export const LongContent: Story = {
  args: {
    defaultValue:
      "The catalog shows each component in isolation.\nInspect narrow layouts, keyboard focus, and longer content.\nAll controls use the current Monokai palette.",
    rows: 5,
  },
};

export const Edit: Story = {
  name: "(Test) Edit",
  play: async ({ args, canvasElement }) => {
    const input = within(canvasElement).getByRole("textbox", { name: "Description" });
    await userEvent.type(input, "First line{enter}Second line");
    await expect(input).toHaveValue("First line\nSecond line");
    await expect(args.onChange).toHaveBeenCalled();
  },
};
export const FocusAndOverrides: Story = {
  name: "(Test) Focus and caller overrides",
  args: { className: "text-xs shadow-none" },
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole("textbox", { name: "Description" });
    await userEvent.click(input);
    await expect(input).toHaveFocus();
    await expect(getComputedStyle(input).boxShadow).toContain("rgba(227, 227, 221, 0.25)");
  },
};
