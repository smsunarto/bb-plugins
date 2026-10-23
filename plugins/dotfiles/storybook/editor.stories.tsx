import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { WorkingFileEditor } from "../src/app/working-file-editor";
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
  title: "Components/Dotfiles/File editor",
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
