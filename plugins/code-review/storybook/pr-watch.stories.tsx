import { isolatedParameters } from "../../../.storybook/layout";
import { RegisteredSurface } from "../../../.storybook/host";
import { banner } from "../../../.storybook/surfaces";
import { expect, userEvent, within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Check, PrWatch } from "../src/shared/schema";

const source = () => import("../src/app/app");

function check(id: number, name: string, state: Check["state"], workflow = "CI"): Check {
  return {
    id: `run:${id}`,
    name,
    workflow,
    state,
    description: state === "failure" ? "Process completed with exit code 1." : null,
    detailsUrl: `https://github.com/acme/api/actions/runs/1/job/${id}`,
    startedAt: "2026-10-26T12:00:00Z",
    completedAt: state === "pending" ? null : "2026-10-26T12:03:12Z",
    jobId: id,
  };
}

function watch(number: number, title: string, checks: Check[], extra: Partial<PrWatch> = {}) {
  return {
    ref: { owner: "acme", repo: "api", number },
    account: "scott",
    url: `https://github.com/acme/api/pull/${number}`,
    title,
    state: "open",
    mergeState: "CLEAN",
    checks: { headRefOid: "4f2c9e1b7a".padEnd(40, "0"), state: null, checks },
    startedAt: "2026-10-26T12:00:00Z",
    polledAt: new Date(Date.now() - 20_000).toISOString(),
    error: null,
    ended: false,
    ...extra,
  } satisfies PrWatch;
}

const failing = watch(
  1042,
  "Rate limit the public API per token",
  [
    check(1, "test (ubuntu)", "failure"),
    check(2, "e2e", "pending"),
    check(3, "lint", "success"),
    check(4, "typecheck", "success"),
    check(5, "Greptile Review", "success", "Greptile"),
  ],
  { mergeState: "BEHIND" },
);
const running = watch(1043, "Retry webhook deliveries with backoff", [
  check(6, "test (ubuntu)", "success"),
  check(7, "e2e", "pending"),
  check(8, "lint", "success"),
]);

const host = (watches: PrWatch[]) => ({
  pluginId: "code-review",
  composer: { scope: { kind: "thread", threadId: "thr_story" } },
  rpc: { prWatches: () => ({ watches }), stopPrWatch: () => ({ stopped: true }) },
});

/** bb's card chrome around the banner, above a stand-in composer. */
function ComposerStack({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-full max-w-2xl flex-col gap-1.5">
      <div className="rounded-lg border border-border bg-surface-raised-solid empty:hidden">
        {children}
      </div>
      <div className="flex h-20 items-start rounded-xl border border-border bg-surface-raised-solid p-3 text-sm text-subtle-foreground">
        Ask for follow-up changes
      </div>
    </div>
  );
}

const meta = {
  title: "Components/Code Review/Watched pull requests",
  component: RegisteredSurface,
  args: {
    source,
    select: (app) => <ComposerStack>{banner(app, "pr-watch")}</ComposerStack>,
  },
  parameters: { ...isolatedParameters, host: host([failing]) },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;

/** One watched pull request: its checks at a glance. */
export const Collapsed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole(
      "button",
      { name: /test \(ubuntu\) failing · Behind base/ },
      { timeout: 15000 },
    );
  },
};

/** Its check list, failures first, opened from the row. */
export const Expanded: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole(
        "button",
        { name: /test \(ubuntu\) failing · Behind base/ },
        { timeout: 15000 },
      ),
    );
    await expect(await canvas.findByText("Process completed with exit code 1.")).toBeVisible();
  },
};

/** A stack: each pull request gets its own row. */
export const Stack: Story = {
  parameters: { host: host([failing, running]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: /2\/3 checks done/ }, { timeout: 15000 });
  },
};

const longNames = watch(
  1044,
  "Move the billing exports onto the new warehouse schema",
  [
    check(
      10,
      "build-and-test (ubuntu-latest, node 22, postgres 16)",
      "failure",
      "Continuous Integration and Deployment",
    ),
    check(11, "lint", "success", "Continuous Integration and Deployment"),
  ],
  { mergeState: "DIRTY" },
);

/** Long workflow and check names in a narrow composer: the title gives way, then the workflow. */
export const LongNames: Story = {
  parameters: { host: host([longNames]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: /failing · Conflicts/ }, { timeout: 15000 }),
    );
    await expect(await canvas.findByText("Process completed with exit code 1.")).toBeVisible();
  },
};
