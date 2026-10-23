import { isolatedParameters } from "../../../.storybook/layout";
import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { WorkingFileEditor } from "../src/app/working-file-editor";
import { HostPicker } from "../src/app/host-picker";
const hosts = {
  selectedHostId: "host_local",
  hosts: [
    { id: "host_local", name: "Design MacBook", connected: true },
    { id: "host_remote", name: "Ubuntu build host", connected: false },
  ],
};
const meta = {
  play: ready,
  title: "Components/Dotfiles/File editor",
  component: WorkingFileEditor,
  tags: ["autodocs"],
  args: {
    path: ".dotfiles/.config/starship.toml",
    value:
      '[character]\nsuccess_symbol = "[❯](bold green)"\nerror_symbol = "[❯](bold red)"\n\n[directory]\ntruncation_length = 3\ntruncate_to_repo = true\n\n[git_branch]\nformat = "on [$symbol$branch]($style) "\n\n[cmd_duration]\nmin_time = 2000\nformat = "took [$duration]($style) "\n',
    onChange: fn(),
    onSave: fn(),
  },
  parameters: {
    ...isolatedParameters,
    host: { pluginId: "dotfiles", rpc: { hosts: () => hosts } },
  },
} satisfies Meta<typeof WorkingFileEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Source: Story = {};
export const Markdown: Story = {
  args: {
    path: "README.md",
    value:
      "# Workstation setup\n\nShell, editor, and agent settings shared between the design MacBook and Ubuntu build host.\n\n## Changing a setting\n\n1. Edit the source under `.dotfiles/`.\n2. Run `mise run render` to update generated files.\n3. Run `mise run check` before publishing.\n\n> Keep host-specific paths in the platform overlay. Never commit credentials.",
  },
};
export const Machines: Story = { render: () => <HostPicker /> };
