import { useState } from "react";
import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { StatusIcon, PriorityIcon } from "../views/list/icons";
import { EmptyState } from "../components/empty-state";
import { ColorSwatchPicker, CheckboxField } from "../views/manage/shared";
import { ConfirmDialog } from "../components/confirm-dialog";
function InteractiveColors() {
  const [value, setValue] = useState("slateblue");
  return <ColorSwatchPicker value={value} onChange={setValue} />;
}
function InteractiveCheckbox() {
  const [checked, setChecked] = useState(false);
  return (
    <CheckboxField checked={checked} label="Include archived tasks" onCheckedChange={setChecked} />
  );
}
const meta = {
  play: ready,
  title: "Plugins/Tasks/Controls",
  component: StatusIcon,
  tags: ["autodocs"],
  args: { status: "todo" },
} satisfies Meta<typeof StatusIcon>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Statuses: Story = {
  render: () => (
    <div className="sb-gallery">
      {(["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const).map(
        (status) => (
          <span className="sb-gallery" key={status}>
            <StatusIcon status={status} />
            {status}
          </span>
        ),
      )}
    </div>
  ),
};
export const Priorities: Story = {
  render: () => (
    <div className="sb-gallery">
      {(["none", "low", "medium", "high", "urgent"] as const).map((priority) => (
        <span className="sb-gallery" key={priority}>
          <PriorityIcon priority={priority} />
          {priority}
        </span>
      ))}
    </div>
  ),
};
export const NoTasks: Story = {
  render: () => (
    <EmptyState
      icon="Inbox"
      title="No tasks yet"
      description="Create your first task to start planning."
    />
  ),
};
export const Colors: Story = {
  render: () => <InteractiveColors />,
  play: async (context) => {
    await ready(context);
    const choice = await within(context.canvasElement).findByRole("radio", { name: "Blue" });
    await userEvent.click(choice);
    await expect(choice).toHaveAttribute("aria-checked", "true");
  },
};
export const Checkbox: Story = {
  render: () => <InteractiveCheckbox />,
  play: async (context) => {
    await ready(context);
    const checkbox = await within(context.canvasElement).findByRole("checkbox");
    await userEvent.click(checkbox);
    await expect(checkbox).toHaveAttribute("aria-checked", "true");
  },
};
export const ConfirmDelete: Story = {
  render: () => (
    <ConfirmDialog
      open
      onOpenChange={fn()}
      title="Delete task?"
      description="This task and its activity will be removed."
      confirmLabel="Delete task"
      onConfirm={fn()}
    />
  ),
};
export const ConfirmBusy: Story = {
  render: () => (
    <ConfirmDialog
      open
      confirmDisabled
      onOpenChange={fn()}
      title="Delete task?"
      description="Removing task…"
      confirmLabel="Deleting…"
      onConfirm={fn()}
    />
  ),
};
