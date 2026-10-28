import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ComponentType } from "react";
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

/** Open the card the way a reader does: show the always-visible card. */
async function openCard(context: { canvasElement: HTMLElement }) {
  await shows(thread.host.name)({ canvasElement: context.canvasElement.ownerDocument.body });
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

/** bb's thread layout: the stream panel with its header, and the side panel that shares the row. */
function StreamLayout({ Component }: { Component: ComponentType<Record<string, unknown>> }) {
  const [sidePanel, setSidePanel] = useState(false);
  return (
    <div className="flex h-[600px] w-[1100px] border border-border text-sm">
      <div
        data-panel-id="thread-detail-timeline-panel"
        data-panel-size={sidePanel ? "60.0" : "100.0"}
        className="flex min-w-0 flex-col"
        style={{ flex: sidePanel ? "60 1 0" : "100 1 0" }}
      >
        <div className="flex h-11 items-center gap-2 border-b border-border px-3">
          <span className="flex-1 truncate">Thread details</span>
          <Component threadId="thr_story" projectId="proj_story" isCompactViewport={false} />
          <button
            type="button"
            className="rounded-md px-2 py-1 text-muted-foreground hover:bg-foreground/[0.06]"
            onClick={() => setSidePanel((open) => !open)}
          >
            Toggle side panel
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-6 text-muted-foreground">
          <p>The agent's messages stream here.</p>
        </div>
      </div>
      {sidePanel ? (
        <div
          className="border-l border-border p-6 text-muted-foreground"
          style={{ flex: "40 1 0" }}
        >
          Side panel
        </div>
      ) : null}
    </div>
  );
}

/** Always visible over the stream, including beside an open side panel. */
export const DockedInStream: Story = {
  args: {
    select: (app) => {
      const registration = app.threadHeaderActions.find((action) => action.id === "thread-details");
      return registration ? <StreamLayout Component={registration.component as never} /> : null;
    },
  },
  // StreamLayout stands in for bb's thread view, so skip the editor frame around it.
  parameters: { editorContext: false },
  beforeEach: () => {
    localStorage.removeItem("kitchen-sink:thread-details:pinned");
  },
  // The card portals to the document body, beside the stream rather than inside it.
  play: ({ canvasElement }) =>
    shows(thread.host.name)({ canvasElement: canvasElement.ownerDocument.body }),
};
