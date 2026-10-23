import { screenParameters } from "../../../.storybook/layout";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { shows } from "../../../.storybook/ready";
import { DotfilesPage } from "../src/app/page";
const hosts = {
  selectedHostId: "host_local",
  hosts: [
    { id: "host_local", name: "Workstation", connected: true },
    { id: "host_remote", name: "Build machine", connected: false },
  ],
};
const meta = {
  title: "Screens/Dotfiles/Repository",
  component: DotfilesPage,
  args: { subPath: "" },
  parameters: { ...screenParameters, host: { pluginId: "dotfiles" } },
} satisfies Meta<typeof DotfilesPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Offline: Story = {
  play: shows("Workstation is not connected."),
  render: () => <DotfilesPage subPath="" />,
  parameters: {
    host: {
      rpc: {
        hosts: () => hosts,
        overview: () => ({ state: "offline", host: { id: "host_local", name: "Workstation" } }),
      },
    },
  },
};
export const RepositoryMissing: Story = {
  play: shows(/No dotfiles repository/),
  render: () => <DotfilesPage subPath="" />,
  parameters: {
    host: {
      rpc: {
        hosts: () => hosts,
        overview: () => ({
          state: "ready",
          host: { id: "host_local", name: "Workstation" },
          repoExists: false,
          repoPath: "/home/developer/git/dotfiles",
        }),
      },
    },
  },
};
