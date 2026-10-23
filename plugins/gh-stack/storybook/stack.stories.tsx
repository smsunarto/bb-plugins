import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { shows } from "../../../.storybook/ready";
const source = () => import("../app");
const changes = {
  additions: 34,
  deletions: 7,
  truncated: false,
  files: [
    {
      path: "plugins/canvas/app.tsx",
      previousPath: null,
      status: "modified",
      additions: 34,
      deletions: 7,
    },
  ],
};
const result = {
  stack: {
    trunk: "main",
    currentBranch: "scott/catalog",
    trunkBehind: 0,
    prunableBranchCount: 0,
    branches: [
      {
        name: "scott/catalog",
        isCurrent: true,
        isMerged: false,
        isQueued: false,
        needsRebase: false,
        hasStash: false,
        stashCount: 0,
        pr: {
          number: 42,
          url: "https://example.com/pr/42",
          state: "OPEN",
          title: "Document plugin components",
          isDraft: true,
          metadataStale: false,
        },
        diff: changes,
        aheadOfRemote: 1,
        behindRemote: 0,
      },
    ],
  },
  workspacePath: "/workspace/bb-plugins",
  error: null,
  checkoutWarning: null,
  pending: changes,
  defaultBranch: "main",
  branchPrefix: "scott/",
  detectedBranchPrefix: "scott/",
  settings: { branchPrefix: "scott/", conventionalCommits: true },
  fetchedAt: 1792670400000,
};
const meta = {
  title: "Plugins/GitHub Stack/Stack panel",
  component: RegisteredSurface,
  args: {
    source,
    select: (app) => {
      const Panel = app.threadPanelActions[0]!.component;
      return <Panel threadId="thr_story" params={null} />;
    },
  },
  parameters: { host: { pluginId: "gh-stack", rpc: { getStack: () => result } } },
  play: shows("Document plugin components"),
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DraftStack: Story = {};
export const NoStack: Story = {
  parameters: {
    host: {
      rpc: {
        getStack: () => ({
          ...result,
          stack: null,
          pending: { ...changes, files: [], additions: 0, deletions: 0 },
        }),
      },
    },
  },
  play: shows(/Start a stack|Create stack|New stack/),
};
export const Loading: Story = {
  parameters: { host: { rpc: { getStack: () => new Promise(() => {}) } } },
  play: shows(/Loading/),
};
export const Offline: Story = {
  parameters: {
    host: { rpc: { getStack: () => Promise.reject(new Error("Checkout host is offline")) } },
  },
  play: shows(/Checkout host is offline/),
};
