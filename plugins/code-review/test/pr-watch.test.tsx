import "./dom.ts";
import { beforeEach, expect, test } from "bun:test";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { PR_WATCH_CHANNEL, prSubPath } from "../src/shared/schema.ts";
import type { PrWatch } from "../src/shared/schema.ts";

const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

beforeEach(() => pluginQueryClient.clear());

const REF = { owner: "acme", repo: "api", number: 7 };

const watch: PrWatch = {
  ref: REF,
  account: "scott",
  url: "https://github.com/acme/api/pull/7",
  title: "Rate limit the API",
  state: "open",
  mergeState: "BEHIND",
  checks: {
    headRefOid: "a".repeat(40),
    state: "failure",
    checks: [
      {
        id: "run:1",
        name: "build",
        workflow: "CI",
        state: "failure",
        description: "Process completed with exit code 1.",
        detailsUrl: "https://github.com/acme/api/actions/runs/1/job/1",
        startedAt: null,
        completedAt: null,
        jobId: 1,
      },
      {
        id: "run:2",
        name: "lint",
        workflow: "CI",
        state: "pending",
        description: "Waiting for a runner",
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
        jobId: 2,
      },
    ],
  },
  startedAt: "2026-10-26T12:00:00.000Z",
  polledAt: "2026-10-26T12:00:30.000Z",
  error: null,
  ended: false,
};

/** The banner bb mounts above a thread's composer. */
async function banner(watches: () => PrWatch[], threadId = "thr_a") {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const customization = app.composerCustomizations.find((each) => each.id === "pr-watch");
  const registered = customization?.banners?.find((each) => each.id === "pr-watch");
  if (!registered) throw new Error("No pr-watch composer banner");
  expect(customization?.scopes).toEqual(["thread"]);
  return renderSlot(
    { component: registered.component },
    {},
    {
      composer: { scope: { kind: "thread", threadId } },
      rpc: {
        prWatches: () => ({ watches: watches() }),
        stopPrWatch: () => ({ stopped: true }),
      },
    },
  );
}

test("shows a watched pull request's checks above the composer, and stops it", async () => {
  let watches = [watch];
  const slot = await banner(() => watches);
  // Other test files can leave DOM behind in the shared document; read only this card.
  const card = within(slot.container);
  try {
    const toggle = await card.findByRole("button", {
      name: "acme/api#7 Rate limit the API: build failing · Behind base. Show checks",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(card.queryByText("build")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(card.getByText("build")).toBeTruthy();
    expect(card.getByText("lint")).toBeTruthy();
    expect(card.getByText("Process completed with exit code 1.")).toBeTruthy();
    // Only a failure carries its reason.
    expect(card.queryByText("Waiting for a runner")).toBeNull();
    expect(card.getByText(/head aaaaaaa · behind base · read/)).toBeTruthy();
    fireEvent.click(card.getByRole("button", { name: "Open in Review" }));
    expect(slot.navigateCalls.at(-1)).toEqual({
      method: "toPluginPanel",
      path: "code-review",
      options: { subPath: prSubPath(REF, "checks", "scott") },
    });

    fireEvent.click(card.getByRole("button", { name: "Unwatch acme/api#7" }));
    await waitFor(() =>
      expect(slot.rpcCalls.some((call) => call.method === "stopPrWatch")).toBe(true),
    );
    watches = [];
    await slot.emitRealtime(PR_WATCH_CHANNEL, { threadId: "thr_a" });
    await waitFor(() => expect(slot.container.textContent).toBe(""));
  } finally {
    slot.lifecycle.unmount();
  }
});

test("renders nothing, so bb hides the card, for a thread that watches nothing", async () => {
  const slot = await banner(() => []);
  try {
    await waitFor(() =>
      expect(slot.rpcCalls.some((call) => call.method === "prWatches")).toBe(true),
    );
    expect(slot.container.textContent).toBe("");
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a cancelled check reads as cancelled, not passed", async () => {
  const { watchChecksState, watchSummary } = await import("../src/app/pr-watch.tsx");
  const [build, lint] = watch.checks.checks;
  const finished = {
    ...watch,
    mergeState: "CLEAN",
    checks: {
      ...watch.checks,
      checks: [
        { ...build!, state: "cancelled" as const },
        { ...lint!, state: "success" as const },
      ],
    },
  };
  expect(watchChecksState(finished)).toBe("cancelled");
  expect(watchSummary(finished)).toBe("1 cancelled");
});

test("the summary names the failing check", async () => {
  const { watchSummary } = await import("../src/app/pr-watch.tsx");
  const [build, lint] = watch.checks.checks;
  const twoFailing = {
    ...watch,
    mergeState: "CLEAN",
    checks: { ...watch.checks, checks: [build!, { ...lint!, state: "failure" as const }] },
  };
  expect(watchSummary(watch)).toBe("build failing · Behind base");
  expect(watchSummary(twoFailing)).toBe("build and 1 more failing");
});
