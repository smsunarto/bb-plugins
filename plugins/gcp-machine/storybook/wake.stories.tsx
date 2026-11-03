import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { createWakeIndicator } from "../src/app/wake-indicator";
import type { MachineIndicator } from "../src/shared/wake-contract";

const offline = createWakeIndicator();
const waking = createWakeIndicator();
waking.set("waking");
const awake = createWakeIndicator();
awake.set("awake");

function showsState(state: MachineIndicator) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const icon = await within(canvasElement).findByTitle(`GCP machine: ${state}`);
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute("data-gcp-state", state);
  };
}

const meta = {
  title: "Components/GCP Machine/Wake indicator",
  component: offline.Icon,
  args: { className: "size-5" },
} satisfies Meta<typeof offline.Icon>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Offline: Story = { play: showsState("offline") };
export const Waking: Story = {
  render: (args) => <waking.Icon {...args} />,
  play: showsState("waking"),
};
export const Awake: Story = {
  render: (args) => <awake.Icon {...args} />,
  play: showsState("awake"),
};
