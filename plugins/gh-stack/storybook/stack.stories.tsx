import { reviewFiles } from "../../../.storybook/fixtures";
import { screenParameters } from "../../../.storybook/layout";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RegisteredSurface } from "../../../.storybook/host";
import { shows } from "../../../.storybook/ready";
const source = () => import("../app");
const changes = {
  additions: 212,
  deletions: 87,
  truncated: false,
  files: reviewFiles.map(({ path, status, additions, deletions, previousPath }) => ({
    path,
    status,
    additions,
    deletions,
    previousPath: previousPath ?? null,
  })),
};
const result = {
  stack: {
    trunk: "main",
    currentBranch: "maya/offline-review-recovery",
    trunkBehind: 2,
    prunableBranchCount: 0,
    branches: [
      {
        name: "maya/offline-review-recovery",
        isCurrent: true,
        isMerged: false,
        isQueued: false,
        needsRebase: false,
        hasStash: false,
        stashCount: 0,
        pr: {
          number: 284,
          url: "https://github.com/example/atlas/pull/284",
          state: "OPEN",
          title: "Keep reviews readable while the checkout reconnects",
          isDraft: true,
          metadataStale: false,
        },
        diff: changes,
        aheadOfRemote: 1,
        behindRemote: 0,
      },
    ],
  },
  workspacePath: "/home/maya/git/atlas",
  error: null,
  checkoutWarning: null,
  pending: changes,
  defaultBranch: "main",
  branchPrefix: "maya/",
  detectedBranchPrefix: "maya/",
  settings: { branchPrefix: "maya/", conventionalCommits: true },
  fetchedAt: 1792670400000,
};
// The active change depends on the cache model and has a follow-up test branch.
result.stack.branches.unshift({
  ...result.stack.branches[0]!,
  name: "maya/revisioned-review-cache",
  isCurrent: false,
  aheadOfRemote: 0,
  behindRemote: 0,
  pr: {
    ...result.stack.branches[0]!.pr,
    number: 282,
    url: "https://github.com/example/atlas/pull/282",
    title: "Store review snapshots by checkout and revision",
    isDraft: false,
  },
  diff: {
    ...changes,
    additions: 76,
    deletions: 12,
    files: [
      {
        path: "src/reviews/snapshot-cache.ts",
        previousPath: null,
        status: "modified",
        additions: 76,
        deletions: 12,
      },
    ],
  },
});
result.stack.branches.push({
  ...result.stack.branches[1]!,
  name: "maya/reconnect-regression-tests",
  isCurrent: false,
  needsRebase: true,
  aheadOfRemote: 1,
  pr: {
    ...result.stack.branches[1]!.pr,
    number: 285,
    url: "https://github.com/example/atlas/pull/285",
    title: "Exercise reconnect while a review comment is being edited",
    isDraft: true,
  },
  diff: {
    ...changes,
    additions: 31,
    deletions: 6,
    files: [
      {
        path: "src/reviews/__tests__/reconnect.test.ts",
        previousPath: null,
        status: "modified",
        additions: 31,
        deletions: 6,
      },
    ],
  },
});
const meta = {
  title: "Screens/GitHub Stack/Stack panel",
  component: RegisteredSurface,
  args: {
    source,
    select: (app) => {
      const Panel = app.threadPanelActions[0]!.component;
      return <Panel threadId="thr_story" params={null} />;
    },
  },
  parameters: {
    ...screenParameters,
    host: { pluginId: "gh-stack", rpc: { getStack: () => result } },
  },
  play: shows("Keep reviews readable while the checkout reconnects"),
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
