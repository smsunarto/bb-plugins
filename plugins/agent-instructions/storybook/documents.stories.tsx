import type { Meta, StoryObj } from "@storybook/react-vite";
import { screenParameters } from "../../../.storybook/layout";
import { RegisteredSurface } from "../../../.storybook/host";
import { nav } from "../../../.storybook/surfaces";
import { ready, shows } from "../../../.storybook/ready";
import { resetDocumentDraftsForTest } from "../src/documents/app";
const source = () => import("../src/app/app");
const metadata = {
  globalProjectId: "dotfiles",
  projects: [
    {
      id: "dotfiles",
      name: "Dotfiles",
      sources: [
        {
          id: "mac",
          hostId: "host_mac",
          hostName: "Personal Mac",
          rootPath: "/Users/example/git/dotfiles",
          connected: true,
          isDefault: true,
        },
      ],
    },
    {
      id: "project",
      name: "My project",
      sources: [
        {
          id: "linux",
          hostId: "host_linux",
          hostName: "Linux",
          rootPath: "/home/me/project",
          connected: true,
          isDefault: true,
        },
      ],
    },
  ],
};
const content =
  "# Project instructions\n\nKeep changes focused. Run the relevant checks before handing off.\n";
const rpc = {
  documentSources: () => metadata,
  readDocument: () => ({ content, sha256: "revision", readOnly: null }),
  documentFiles: () => ({
    files: [
      "AGENTS.md",
      ".agents/skills/review/SKILL.md",
      ".agents/skills/review/references/checklist.md",
    ],
    truncated: false,
    warnings: [],
  }),
};
const meta = {
  title: "Screens/Agent Instructions/Source files",
  component: RegisteredSurface,
  beforeEach: () => resetDocumentDraftsForTest(),
  parameters: { ...screenParameters, host: { pluginId: "agent-instructions", rpc } },
  args: { source, select: (app) => nav(app, "projects/project/linux/AGENTS.md") },
  play: ready,
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Project: Story = { play: shows("AGENTS.md") };
export const Global: Story = {
  args: {
    select: (app) => nav(app, "global/dotfiles/mac/.dotfiles/.agents/instructions/shared.md"),
  },
};
export const Reference: Story = {
  args: {
    select: (app) =>
      nav(app, "projects/project/linux/.agents/skills/review/references/checklist.md"),
  },
};
export const Files: Story = {
  args: { select: (app) => nav(app, "projects/project/linux/AGENTS.md", "files") },
  play: shows("AGENTS.md"),
};
