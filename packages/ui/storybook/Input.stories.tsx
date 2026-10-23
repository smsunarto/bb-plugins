import { useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { Input } from "../src/input";

const meta = {
  title: "Shared/Input",
  component: Input,
  args: { "aria-label": "Name", placeholder: "Component name", onChange: fn() },
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
} satisfies Meta<typeof Input>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true, defaultValue: "Unavailable" } };
export const LongValue: Story = {
  args: { defaultValue: "Review every component in the current checkout before continuing" },
};

export const Edit: Story = {
  name: "(Test) Edit",
  play: async ({ args, canvasElement }) => {
    const input = within(canvasElement).getByRole("textbox", { name: "Name" });
    await userEvent.type(input, "Monokai");
    await expect(input).toHaveValue("Monokai");
    await expect(args.onChange).toHaveBeenCalled();
  },
};
export const FocusAndOverrides: Story = {
  name: "(Test) Focus and caller overrides",
  parameters: { controls: { disable: true } },
  render: () => {
    const input = useRef<HTMLInputElement>(null);
    return (
      <div className="sb-stack">
        <button onClick={() => input.current?.focus()}>Focus input</button>
        <Input ref={input} aria-label="Shadowless input" className="h-7 text-xs shadow-none" />
        <Input
          aria-label="Invalid input"
          className="h-7 text-xs shadow-none focus-visible:ring-destructive-text"
        />
        <Input
          aria-label="Explicit touch size"
          className="h-7 text-xs max-md:pointer-coarse:h-9 max-md:pointer-coarse:text-sm"
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox", { name: "Shadowless input" });
    await userEvent.click(canvas.getByRole("button", { name: "Focus input" }));
    await expect(input).toHaveFocus();
    await expect(getComputedStyle(input).boxShadow).toContain("rgba(227, 227, 221, 0.25)");
    await userEvent.click(canvas.getByRole("textbox", { name: "Invalid input" }));
    await expect(
      getComputedStyle(canvas.getByRole("textbox", { name: "Invalid input" })).boxShadow,
    ).toContain("rgb(227, 70, 113)");
  },
};
export const ThemedStyles: Story = {
  name: "(Test) Themed styles",
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole("textbox", { name: "Name" });
    await expect(getComputedStyle(input).fontSize).toBe("13px");
    await expect(getComputedStyle(input).height).toBe("36px");
  },
};
