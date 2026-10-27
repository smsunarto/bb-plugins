import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { nav } from "../../../.storybook/surfaces";
import { shows } from "../../../.storybook/ready";

const source = () => import("../app");
const meta = {
  title: "Screens/SlopCop/Rules",
  component: RegisteredSurface,
  args: { source, select: (app) => nav(app) },
  play: shows("New rule"),
  parameters: {
    host: {
      pluginId: "slopcop",
      rpc: {
        listRules: () => ({ rules: [] }),
        listRuns: () => ({ runs: [] }),
        status: () => ({
          ghAvailable: false,
          ghLogin: null,
          watchedRepos: [],
          pollSeconds: 60,
          defaultThreadSection: "",
        }),
      },
    },
  },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
