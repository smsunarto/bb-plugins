import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { JsonView } from "../src/app/json-view";
import { Empty, QueryError, Pages } from "../src/app/controls";
import "../src/app/traces.css";
const meta = {
  play: ready,
  title: "Components/Traces/Inspector",
  component: JsonView,
  tags: ["autodocs"],
  args: {
    value: {
      sessionId: "session_review_reconnect",
      provider: "codex",
      task: "Verify cached reviews survive a checkout reconnect",
      status: "complete",
      startedAt: "2026-10-23T09:42:10.000Z",
      durationMs: 18432,
      usage: { inputTokens: 18420, cachedInputTokens: 12288, outputTokens: 2186 },
      tools: [
        { name: "read_file", path: "src/reviews/use-review-query.ts", durationMs: 42, ok: true },
        {
          name: "exec_command",
          command: "bun test src/reviews/__tests__/reconnect.test.ts",
          durationMs: 2418,
          exitCode: 0,
          ok: true,
        },
      ],
      result: { testsPassed: 8, staleResponseIgnored: true, draftPreserved: true },
      error: null,
    },
  },
} satisfies Meta<typeof JsonView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Structured: Story = {};
export const LongText: Story = {
  args: {
    value: {
      message:
        "[refresh] Checkout atlas/frontend disconnected; retaining snapshot r142.\n[refresh] Switched to atlas/api; request r143 started.\n[refresh] Ignored late response r142 for superseded checkout.\n".repeat(
          35,
        ),
    },
  },
};
export const ManyKeys: Story = {
  args: { value: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`event_${i}`, i])) },
};
export const NoSession: Story = {
  render: () => (
    <Empty title="No matching sessions">Try a different filter or check Sources.</Empty>
  ),
};
export const Unavailable: Story = {
  render: () => (
    <QueryError error={new globalThis.Error("The trace host is offline")} retry={fn()} />
  ),
};
export const Pagination: Story = {
  render: () => <Pages page={2} loading={false} hasNext onPrevious={fn()} onNext={fn()} />,
};
