import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { CommentForm } from "../src/app/comment-form";
function InteractiveForm(args: ComponentProps<typeof CommentForm>) {
  const [value, setValue] = useState(args.value);
  return (
    <CommentForm
      {...args}
      value={value}
      onChange={(next) => {
        setValue(next);
        args.onChange(next);
      }}
    />
  );
}
const meta = {
  render: (args) => <InteractiveForm {...args} />,
  title: "Components/Code Review/Comment form",
  component: CommentForm,
  tags: ["autodocs"],
  play: ready,
  args: {
    label: "Review comment",
    submitLabel: "Add comment",
    value:
      "Could we keep the previous file list visible while this refresh is pending? Clearing it loses the selected file and makes the panel jump. The reconnect test should assert that the draft comment survives as well.",
    onChange: fn(),
    onSubmit: fn(),
    onCancel: fn(),
    pending: false,
    error: null,
  },
} satisfies Meta<typeof CommentForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Draft: Story = {
  play: async (context) => {
    await ready(context);
    const field = await within(context.canvasElement).findByRole("textbox", {
      name: "Review comment",
    });
    await userEvent.clear(field);
    await userEvent.type(field, "Please also ignore a late response from the previous checkout.");
    await expect(field).toHaveValue(
      "Please also ignore a late response from the previous checkout.",
    );
  },
};
export const Empty: Story = { args: { value: "" } };
export const Sending: Story = { args: { pending: true } };
export const Error: Story = { args: { error: "The review changed. Refresh before submitting." } };
export const Blocked: Story = { args: { blocked: true } };
