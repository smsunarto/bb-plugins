import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { shows } from "../../../.storybook/ready";
const source = () => import("../src/app/app");
const thread = {
  id: "thr_story",
  projectId: "proj_story",
  title: "Thread details",
  displayTitle: "Thread details",
  environment: {
    id: "env_story",
    name: "bb-plugins",
    path: "/Users/scott/git/bb-plugins",
    isWorktree: false,
    providerId: "local",
    workspaceDisplayKind: null,
  },
  host: { id: "host_mac", name: "Scott's MacBook Pro" },
};
const meta = {
  title: "Components/Kitchen Sink/Thread details",
  component: RegisteredSurface,
  play: shows(thread.host.name),
  args: {
    source,
    select: (app) => {
      const registration = app.threadContextCardRows.find((row) => row.id === "workspace");
      if (!registration) return null;
      const Component = registration.component;
      return (
        <div className="w-[280px] rounded-lg border border-border bg-card p-2">
          <Component
            threadId={thread.id}
            projectId={thread.projectId}
            environment={thread.environment}
          />
        </div>
      );
    },
  },
  parameters: {
    host: {
      pluginId: "kitchen-sink",
      sidebarThreads: {
        status: "ready",
        threads: [thread],
        projects: [{ id: "proj_story", name: "bb-plugins" }],
      },
      rpc: { projectScripts: () => ({ scripts: [] }) },
    },
  },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const WithScripts: Story = {
  parameters: {
    host: {
      ...meta.parameters.host,
      rpc: {
        projectScripts: () => ({
          scripts: [{ id: "dev", name: "Dev server", command: "bun run dev" }],
        }),
      },
    },
  },
};
