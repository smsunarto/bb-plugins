import { shows } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { directive } from "../../../.storybook/surfaces";
const source = () => import("../app");
const id = "b2ebea6a-0d32-4e3a-9eba-789126676318";
const report = {
  id,
  request:
    "Review the checkout reconnect flow. Can a delayed request replace the selected review or lose a draft comment?",
  response:
    "### Finding: a stale response can replace the selected checkout\n\nIn `use-review-query.ts`, the refresh callback writes its result without checking whether the reviewer has switched repositories. A slow response for Atlas/frontend can overwrite Atlas/api.\n\n**Recommendation:** capture the checkout key when the request starts, compare it before applying the result, and leave the previous snapshot visible during refresh.\n\n**Validation:** use two deferred requests, resolve the newer one first, then verify that the older response cannot change the selected file or comment draft.",
  status: "completed",
  createdAt: "2026-10-22T12:00:00Z",
};
const meta = {
  play: shows(/Finding: a stale response can replace the selected checkout/),
  title: "Components/Amp/Oracle card",
  component: RegisteredSurface,
  args: { source, select: (app) => directive(app, "amp-oracle", { reportId: id }) },
  parameters: {
    host: {
      pluginId: "amp",
      rpc: { getOracleReport: () => ({ report, error: null }) },
      sdk: { subscribe: () => () => {} },
    },
  },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Completed: Story = {};
export const Running: Story = {
  play: shows("Oracle is reasoning…"),
  parameters: {
    host: {
      pluginId: "amp",
      rpc: {
        getOracleReport: () => ({
          report: { ...report, id: "a2ebea6a-0d32-4e3a-9eba-789126676318", status: "running" },
          error: null,
        }),
      },
      sdk: { subscribe: () => () => {} },
    },
  },
  args: {
    select: (app) =>
      directive(app, "amp-oracle", { reportId: "a2ebea6a-0d32-4e3a-9eba-789126676318" }),
  },
};
export const Missing: Story = {
  play: shows("Report is unavailable on the selected host"),
  args: {
    select: (app) =>
      directive(app, "amp-oracle", { reportId: "d2ebea6a-0d32-4e3a-9eba-789126676318" }),
  },
  parameters: {
    host: {
      pluginId: "amp",
      rpc: {
        getOracleReport: () => ({
          report: null,
          error: "Report is unavailable on the selected host",
        }),
      },
      sdk: { subscribe: () => () => {} },
    },
  },
};
export const InvalidReference: Story = {
  play: shows("The Oracle report reference is invalid."),
  args: { select: (app) => directive(app, "amp-oracle", { reportId: "invalid" }) },
};
