import { isolatedParameters } from "../../../.storybook/layout";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { shows } from "../../../.storybook/ready";
import { StackLane, UncommittedCard, CommitExpansionContext } from "../src/app/workspace-lane";
import { BranchActions } from "../src/app/branch-actions";
import { Conflicts } from "../src/app/conflicts";
import type { Branch, Workspace } from "../src/shared/schema";
import "../src/app/gitbutler.css";
const target = { threadId: "thr_story", repositoryKey: "." };
const branch: Branch = {
  name: "scott/component-catalog",
  status: "unpushed",
  rawStatus: "Unpushed",
  push: "push",
  reviewId: null,
  ci: null,
  commits: [
    {
      commitId: "aabbccddeeff",
      changeId: "story",
      message: "feat(storybook): document plugin components",
      authorName: "Developer",
      createdAt: "2026-10-22T12:00:00Z",
      conflicted: false,
    },
  ],
  upstreamCommits: [],
  newUpstream: 0,
};
const changes = [{ path: "plugins/canvas/app.tsx", kind: "modified" as const }];
const stack = { key: branch.name, branches: [branch], assignedChanges: changes };
const workspace: Workspace = {
  state: "ready",
  reason: null,
  environmentId: "env_story",
  repositoryKey: ".",
  repoName: "bb-plugins",
  unassignedChanges: changes,
  stacks: [stack],
  base: null,
  upstream: null,
  conflictedFiles: ["plugins/canvas/app.tsx"],
};
const rpc = {
  reviewRequests: () => ({ requests: [] }),
  reviews: () => ({ reviews: [], reason: null }),
  commitChanges: () => ({ changes, reason: null }),
  conflictResolution: () => ({ subthread: null }),
};
const meta = {
  title: "Components/GitButler/Workspace",
  component: StackLane,
  args: { target, stack, behind: 0, onOpenFile: fn() },
  parameters: { ...isolatedParameters, host: { pluginId: "gitbutler", rpc } },
  play: shows(branch.name),
} satisfies Meta<typeof StackLane>;
export default meta;
type Story = StoryObj<typeof meta>;
export const BranchLane: Story = {
  render: (args) => (
    <CommitExpansionContext value={{ ...target, expanded: null, onToggle: fn(), onOpenFile: fn() }}>
      <StackLane {...args} />
    </CommitExpansionContext>
  ),
};
export const Uncommitted: Story = {
  render: () => <UncommittedCard changes={changes} onOpenFile={fn()} attention />,
  play: shows("Uncommitted changes"),
};
export const Actions: Story = {
  render: () => (
    <BranchActions
      target={target}
      branch={branch}
      landable
      pushedWith={[branch]}
      branchesAbove={0}
      behind={0}
    />
  ),
  play: shows("Push"),
};
export const Conflict: Story = {
  render: () => <Conflicts target={target} workspace={workspace} />,
  play: shows("Conflicts to resolve"),
};
