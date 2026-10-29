import { screenParameters } from "../../../.storybook/layout";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { shows } from "../../../.storybook/ready";
import { DotfilesPage } from "../src/app/page";
const hosts = {
  selectedHostId: "host_local",
  hosts: [
    { id: "host_local", name: "Design MacBook", connected: true },
    { id: "host_remote", name: "Ubuntu build host", connected: false },
  ],
};
const shellConfig = `[character]
success_symbol = "[❯](bold green)"
error_symbol = "[❯](bold red)"

[directory]
truncation_length = 3
truncate_to_repo = true

[git_branch]
format = "on [$symbol$branch]($style) "

[cmd_duration]
min_time = 2000
format = "took [$duration]($style) "
`;
let savedConfig = shellConfig;
let revision = 1;
const meta = {
  title: "Screens/Dotfiles/Repository",
  component: DotfilesPage,
  beforeEach: () => {
    savedConfig = shellConfig;
    revision = 1;
  },
  args: { subPath: "" },
  parameters: { ...screenParameters, host: { pluginId: "dotfiles" } },
} satisfies Meta<typeof DotfilesPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {
  args: { subPath: ".dotfiles/.config/starship.toml" },
  parameters: {
    host: {
      rpc: {
        hosts: () => hosts,
        overview: () => ({
          state: "ready",
          host: { id: "host_local", name: "Design MacBook" },
          repoPath: "/home/maya/git/dotfiles",
          branch: "maya/shell-prompt",
          groups: [],
          gitEntries: [{ status: " M", path: ".dotfiles/.config/starship.toml" }],
        }),
        readFile: () => ({
          content: savedConfig,
          headContent: shellConfig.replace("truncation_length = 3", "truncation_length = 5"),
          sha256: `fixture-${revision}`,
        }),
        saveFile: (raw: { content: string }) => {
          savedConfig = raw.content;
          return { outcome: "written", sha256: `fixture-${++revision}`, renderHint: false };
        },
      },
    },
  },
  play: shows(".dotfiles/.config/starship.toml"),
};
export const Offline: Story = {
  play: shows("Design MacBook is not connected."),
  render: () => <DotfilesPage subPath="" />,
  parameters: {
    host: {
      rpc: {
        hosts: () => hosts,
        overview: () => ({ state: "offline", host: { id: "host_local", name: "Design MacBook" } }),
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
          state: "noRepository",
          host: { id: "host_local", name: "Design MacBook" },
          repoPath: "/home/maya/git/dotfiles",
        }),
      },
    },
  },
};
