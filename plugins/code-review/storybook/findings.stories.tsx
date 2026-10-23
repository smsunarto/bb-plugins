import { isolatedParameters } from "../../../.storybook/layout";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { FindingCard } from "../src/app/finding";
const meta = {
  parameters: isolatedParameters,
  title: "Components/Code Review/Findings",
  component: FindingCard,
  tags: ["autodocs"],
  play: ready,
  args: {
    finding: {
      id: "finding_story",
      priority: 1,
      title: "Ignore a response after the user switches checkouts",
      body: "Start loading Atlas/frontend, then switch to Atlas/api before the first request resolves. The frontend response can overwrite the selected review because this callback never checks the current checkout key. Compare the request key before updating the cache, and add a deferred-response test for this sequence.",
      path: "src/reviews/use-review-query.ts",
      line: 87,
      startLine: 82,
      side: "RIGHT",
    },
    stale: false,
    onReveal: fn(),
    pr: null,
  },
} satisfies Meta<typeof FindingCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Urgent: Story = {};
export const Normal: Story = {
  args: {
    finding: {
      ...meta.args.finding,
      priority: 2,
      title: "Explain why this cached snapshot cannot refresh",
      body: "When the host is offline, the panel shows a timestamp but no connection state. Include the offline reason beside the Retry action so the reviewer knows whether the snapshot can be refreshed.",
      path: "src/reviews/offline-notice.tsx",
      line: 31,
      startLine: 28,
    },
  },
};
export const Low: Story = {
  args: {
    finding: {
      ...meta.args.finding,
      priority: 3,
      title: "Name the checkout in the recovery instructions",
      body: "The runbook says to restart the host but does not identify the affected checkout. Include the repository name so the operator can distinguish several connected workspaces.",
      path: "docs/reviews/offline-recovery.md",
      line: 18,
      startLine: 16,
    },
  },
};
export const Stale: Story = { args: { stale: true } };
