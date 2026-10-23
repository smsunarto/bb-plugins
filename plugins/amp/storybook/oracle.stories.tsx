import { shows } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { directive } from "../../../.storybook/surfaces";
const source = () => import("../app");
const id = "b2ebea6a-0d32-4e3a-9eba-789126676318";
const report = {
  id,
  request: "Review the component structure",
  response: "The components preserve state while their container resizes.",
  status: "completed",
  trace: [],
  createdAt: "2026-10-22T12:00:00Z",
};
const meta = {
  play: shows(report.response),
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
  play: shows("Checking layout"),
  parameters: {
    host: {
      pluginId: "amp",
      rpc: {
        getOracleReport: () => ({
          report: {
            ...report,
            id: "a2ebea6a-0d32-4e3a-9eba-789126676318",
            status: "running",
            trace: [
              {
                id: "step1",
                kind: "thinking",
                title: "Checking layout",
                content: "Inspecting narrow controls.",
                toolCallId: null,
                status: null,
                createdAt: report.createdAt,
              },
            ],
          },
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
