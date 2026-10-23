import type { Meta, StoryObj } from "@storybook/react-vite";
import { ready } from "../../../.storybook/ready";
import { RegisteredSurface } from "../../../.storybook/host";
import { directive } from "../../../.storybook/surfaces";
const meta = {
  title: "Components/Docs/Document card",
  component: RegisteredSurface,
  args: { source: () => import("../app"), select: (app) => directive(app, "docs", {}) },
  parameters: { host: { pluginId: "scott-docs" } },
  play: ready,
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const HtmlCard: Story = {
  args: {
    select: (app) =>
      directive(app, "docs", {
        vault: "personal",
        path: "report.html",
        title: "Weekly engineering report",
      }),
  },
};
export const InvalidLink: Story = { args: { select: (app) => directive(app, "docs", {}) } };
