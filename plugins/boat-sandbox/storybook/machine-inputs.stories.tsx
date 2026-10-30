import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { shows } from "../../../.storybook/ready";
import { machineProviderInputs } from "../../../.storybook/surfaces";
import { expect, userEvent, waitFor, within } from "storybook/test";

const source = () => import("../src/app/app");
const options = {
  defaultType: "default",
  types: [
    { type: "small", available: true, reason: null },
    { type: "default", available: true, reason: null },
    { type: "large", available: true, reason: null },
    { type: "xlarge", available: false, reason: "Not available on this plan" },
  ],
  snapshots: [] as string[],
};
const meta = {
  title: "Components/Boat Sandbox/Machine inputs",
  component: RegisteredSurface,
  args: { source, select: (app) => machineProviderInputs(app, "boat-sandbox") },
  play: shows("default"),
  parameters: {
    host: { pluginId: "boat-sandbox", rpc: { "launch.options": () => options } },
  },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const FromSnapshot: Story = {
  parameters: {
    host: {
      ...meta.parameters.host,
      rpc: { "launch.options": () => ({ ...options, snapshots: ["toolchain-ready"] }) },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Boat sandbox options" }, { timeout: 15000 }),
    );
    await expect(await page.findByRole("menuitem", { name: /xlarge/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.click(await page.findByRole("menuitem", { name: /toolchain-ready/ }));
    await waitFor(() => expect(canvas.getByText("default · toolchain-ready")).toBeVisible());
  },
};
