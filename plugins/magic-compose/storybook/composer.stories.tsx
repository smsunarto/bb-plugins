import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { composerAction } from "../../../.storybook/surfaces";
import { expect, within } from "storybook/test";
import { DEFAULT_PREFERENCES } from "../lib/preferences";

const source = () => import("../app");
const meta = {
  title: "Components/Magic Compose/Composer toggle",
  component: RegisteredSurface,
  args: { source, select: (app) => composerAction(app, "toggle") },
  play: async ({ canvasElement }) => {
    const toggle = await within(canvasElement).findByRole(
      "button",
      { name: /Magic Compose/ },
      { timeout: 30000 },
    );
    await expect(toggle).toBeVisible();
  },
  parameters: {
    host: {
      pluginId: "magic-compose",
      rpc: {
        preferencesGet: () => ({ preferences: DEFAULT_PREFERENCES }),
        warm: () => ({ warmed: false }),
      },
      composerScope: { kind: "new-thread", projectId: null },
    },
  },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Off: Story = {};
