import { ready, shows } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { WorkingFileEditor } from "../src/app/working-file-editor";
import { DotfilesPage } from "../src/app/page";
import { HostPicker } from "../src/app/host-picker";
const hosts = {
  selectedHostId: "host_local",
  hosts: [
    { id: "host_local", name: "Workstation", connected: true },
    { id: "host_remote", name: "Build machine", connected: false },
  ],
};
const meta = {
  play: ready,
  title: "Plugins/Dotfiles/File editor",
  component: WorkingFileEditor,
  tags: ["autodocs"],
  args: {
    path: "config.toml",
    value: '[editor]\ntheme = "monokai"\nautosave = true\n',
    onChange: fn(),
    onSave: fn(),
  },
  parameters: { host: { pluginId: "dotfiles", rpc: { hosts: () => hosts } } },
} satisfies Meta<typeof WorkingFileEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Source: Story = {};
export const Markdown: Story = {
  args: {
    path: "README.md",
    value:
      "# Development settings\n\nUse the **workspace** configuration for this project.\n\n- Run checks\n- Review the result",
  },
};
export const Machines: Story = { render: () => <HostPicker /> };
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
