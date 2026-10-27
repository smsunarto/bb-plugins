import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { RegisteredSurface } from "../../../.storybook/host";
import { shows } from "../../../.storybook/ready";

const source = () => import("../src/app/app");
const ENV = "env_story";
const thread = {
  id: "thr_story",
  projectId: "proj_story",
  title: "Thread details",
  displayTitle: "Thread details",
  environment: {
    id: ENV,
    name: "bb-plugins",
    branchName: "gitbutler/workspace",
    path: "/Users/scott/git/bb-plugins",
    isWorktree: false,
    providerId: "local",
    workspaceDisplayKind: null,
  },
  host: { id: "host_mac", name: "Scott's MacBook Pro (2)" },
};
const status = {
  outcome: "available",
  workspace: {
    branch: { currentBranch: "gitbutler/workspace", defaultBranch: "main" },
    checkout: { kind: "branch", branchName: "gitbutler/workspace", headSha: null },
    mergeBase: null,
    workingTree: { insertions: 2765, deletions: 161, fileCount: 12, files: [] },
  },
};

function host(options: {
  scripts?: Array<{ id: string; name: string; command: string }>;
  pullRequest?: { number: number; state: "open" | "draft"; title: string; url: string };
}) {
  return {
    pluginId: "kitchen-sink",
    sidebarThreads: {
      status: "ready",
      threads: [thread],
      projects: [{ id: "proj_story", name: "bb-plugins" }],
    },
    sdk: {
      subscribe: () => () => {},
      environments: { status: async () => status },
    },
    rpc: {
      projectScripts: () => ({ scripts: options.scripts ?? [] }),
      pullRequests: ({ keys }: { keys: string[] }) =>
        Object.fromEntries(
          keys.map((key) => [
            key,
            options.pullRequest
              ? { outcome: "available", pullRequest: options.pullRequest }
              : { outcome: "absent" },
          ]),
        ),
    },
  };
}

/** Open the card the way a reader does: click the header button. */
async function openCard(context: { canvasElement: HTMLElement }) {
  const button = await within(context.canvasElement).findByRole(
    "button",
    { name: "Thread details" },
    { timeout: 15000 },
  );
  await userEvent.click(button);
  await shows("Open in editor")({ canvasElement: context.canvasElement.ownerDocument.body });
}

const meta = {
  title: "Components/Kitchen Sink/Thread details",
  component: RegisteredSurface,
  play: openCard,
  args: {
    source,
    select: (app) => {
      const registration = app.threadHeaderActions.find((action) => action.id === "thread-details");
      if (!registration) return null;
      const Component = registration.component;
      return (
        <div className="flex justify-end p-3" style={{ width: 360, minHeight: 360 }}>
          <Component threadId="thr_story" projectId="proj_story" isCompactViewport={false} />
        </div>
      );
    },
  },
  parameters: { host: host({}) },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NoPullRequest: Story = {};
export const WithScriptAndPullRequest: Story = {
  parameters: {
    host: host({
      scripts: [{ id: "dev", name: "Dev server", command: "bun run dev" }],
      pullRequest: {
        number: 482,
        state: "open",
        title: "Add the thread details card",
        url: "https://github.com/smsunarto/bb-plugins/pull/482",
      },
    }),
  },
};
