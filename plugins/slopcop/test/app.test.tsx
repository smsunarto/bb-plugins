// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Rule, Run } from "../lib/types";

afterEach(() => {
  const cancel = screen.queryByRole("button", { name: "Cancel" });
  if (cancel) fireEvent.click(cancel);
  cleanup();
});

const rule: Rule & { dangerous: boolean } = {
  id: "test-rule",
  name: "Review checkout",
  repo: "example/repo",
  enabled: false,
  mode: "shadow",
  triggers: ["ready_for_review", "new_commits"],
  commentKeywords: [],
  conditions: [{ kind: "exclude_author", logins: ["owner"] }],
  authorTrust: "past_contributors",
  requesterTrust: "org_members",
  prompt: "Check correctness.",
  request: {
    projectId: "project-test",
    providerId: "codex",
    model: "saved-model",
    reasoningLevel: "high",
    permissionMode: "auto",
    serviceTier: "ultrafast",
    sessionOptions: { custom: "keep" },
    environment: {
      type: "provider",
      environmentProviderId: "project-checkout",
      inputs: { path: "/saved/checkout" },
      machine: { type: "existing", hostId: "host-test" },
    },
  },
  dedupe: "once_per_head_sha",
  reviewStrategy: "update",
  visibility: "hidden",
  createdAt: 1,
  updatedAt: 1,
  commentTriggerEnabledAt: null,
  dangerous: false,
};

async function mount(
  saveRule = vi.fn(async (_input: unknown) => ({ rule })),
  _displayedRule = rule,
) {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        listRules: () => ({ rules: [rule] }),
        listRuns: () => ({ runs: [] }),
        status: () => ({ ghLogin: "test" }),
        saveRule,
      },
    },
  );
  fireEvent.click(await slot.findByText("Review checkout"));
  return { slot, saveRule };
}

it("saves an instructions edit without replacing a disabled rule's execution settings", async () => {
  const { slot, saveRule } = await mount();
  expect(slot.queryByRole("button", { name: /submit/i })).toBeNull();
  const instructions = slot.getByLabelText("Review instructions");
  expect(instructions.tagName).toBe("TEXTAREA");
  fireEvent.change(instructions, {
    target: { value: "Check failure handling." },
  });
  fireEvent.click(slot.getByRole("button", { name: "Save rule" }));
  await waitFor(() => expect(saveRule).toHaveBeenCalledOnce());
  expect(saveRule.mock.calls[0]?.[0]).toMatchObject({
    id: rule.id,
    rule: {
      enabled: false,
      prompt: "Check failure handling.",
      request: rule.request,
      mode: rule.mode,
      conditions: rule.conditions,
      dedupe: rule.dedupe,
      visibility: rule.visibility,
    },
  });
});

it("cancels without saving the draft", async () => {
  const { slot, saveRule } = await mount();
  fireEvent.change(slot.getByLabelText("Review instructions"), {
    target: { value: "Unsaved" },
  });
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  expect(saveRule).not.toHaveBeenCalled();
  fireEvent.click(await slot.findByText("Review checkout"));
  expect(slot.getByLabelText("Review instructions")).toHaveProperty("value", rule.prompt);
});

it("keeps the draft and exposes a retry when saving fails", async () => {
  const saveRule = vi.fn().mockRejectedValue(new Error("Server unavailable"));
  const { slot } = await mount(saveRule);
  fireEvent.change(slot.getByLabelText("Review instructions"), {
    target: { value: "Keep this draft" },
  });
  fireEvent.click(slot.getByRole("button", { name: "Save rule" }));
  await slot.findByRole("alert");
  await slot.findByText("Server unavailable");
  expect(slot.getByLabelText("Review instructions")).toHaveProperty("value", "Keep this draft");
  await waitFor(() =>
    expect(slot.getByRole("button", { name: "Save rule" })).not.toHaveProperty("disabled", true),
  );
});

it("requires saving changed settings before running a test", async () => {
  const { slot } = await mount();
  const summary = slot.getByText("Test this rule");
  fireEvent.click(summary);
  fireEvent.change(slot.getByLabelText("Review instructions"), {
    target: { value: "Unsaved behavior" },
  });
  expect(slot.getByText("Save your changes before testing this rule.")).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Dry run" })).toBeNull();
});

it("restores an unsaved draft when the host remounts the panel", async () => {
  const { slot } = await mount();
  fireEvent.change(slot.getByLabelText("Review instructions"), {
    target: { value: "Survives mobile layout" },
  });
  slot.lifecycle.unmount();
  const app = await loadPluginApp(() => import("../app"));
  const restored = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        listRules: () => ({ rules: [rule] }),
        listRuns: () => ({ runs: [] }),
        status: () => ({ ghLogin: "test" }),
      },
    },
  );
  expect(restored.getByLabelText("Review instructions")).toHaveProperty(
    "value",
    "Survives mobile layout",
  );
});

it("does not mark reordered saved filters as unsaved changes", async () => {
  const { slot } = await mount(undefined, {
    ...rule,
    conditions: [
      { kind: "paths", globs: ["src/**"] },
      { kind: "has_label", labels: ["review"] },
      { kind: "exclude_author", logins: ["owner"] },
    ],
  });
  fireEvent.click(slot.getByText("Test this rule"));
  expect(slot.queryByText("Save your changes before testing this rule.")).toBeNull();
  expect(slot.getByRole("button", { name: "Dry run" })).toBeTruthy();
});

it("shows actionable inline validation instead of internal error codes", async () => {
  const { slot, saveRule } = await mount();
  fireEvent.change(slot.getByLabelText("Rule name"), { target: { value: "" } });
  fireEvent.click(slot.getByRole("button", { name: "Save rule" }));
  expect(await slot.findByRole("alert")).toHaveProperty(
    "textContent",
    "Give the rule a name first",
  );
  expect(saveRule).not.toHaveBeenCalled();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("shows loading and retryable error states instead of false gh-unauthenticated or empty states", async () => {
  const app = await loadPluginApp(() => import("../app"));
  let rulesAttempt = 0;
  let statusAttempt = 0;
  const firstRules = deferred<{ rules: (Rule & { dangerous: boolean })[] }>();
  const firstStatus = deferred<{ ghLogin: string | null }>();

  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        listRules: () => {
          rulesAttempt += 1;
          if (rulesAttempt === 1) return firstRules.promise;
          return { rules: [rule] };
        },
        listRuns: () => ({ runs: [] }),
        status: () => {
          statusAttempt += 1;
          if (statusAttempt === 1) return firstStatus.promise;
          if (statusAttempt === 2) return { ghLogin: null };
          return { ghLogin: "octocat" };
        },
      },
    },
  );

  // While loading: never claim "gh not authenticated" or "No rules yet".
  expect(slot.getByText("Checking gh…")).toBeTruthy();
  expect(slot.getByText("Loading rules…")).toBeTruthy();
  expect(slot.queryByText("gh not authenticated")).toBeNull();
  expect(slot.queryByText("No rules yet")).toBeNull();

  // Reject both initial loads -> error + retry UI, still not "gh not authenticated".
  firstRules.reject(new Error("Rules backend offline"));
  firstStatus.reject(new Error("Status RPC failed"));
  await slot.findByText("Rules backend offline");
  await slot.findByText(/gh status unavailable/);
  expect(slot.queryByText("gh not authenticated")).toBeNull();
  expect(slot.queryByText("No rules yet")).toBeNull();

  // Retry both -> recovers cleanly.
  const retryButtons = slot.getAllByRole("button", { name: "Retry" });
  expect(retryButtons).toHaveLength(2);
  fireEvent.click(retryButtons[0]!);
  fireEvent.click(retryButtons[1]!);

  await slot.findByText("Review checkout");
  await slot.findByText("gh not authenticated");
});

it("coalesces runs-changed bursts to refetch listRuns only", async () => {
  const app = await loadPluginApp(() => import("../app"));
  let runsCall = 0;
  const firstRuns = deferred<{ runs: Run[] }>();
  const secondRuns = deferred<{ runs: Run[] }>();
  const listRules = vi.fn(() => ({ rules: [rule] }));
  const status = vi.fn(() => ({ ghLogin: "test" }));
  const listRuns = vi.fn(() => {
    runsCall += 1;
    if (runsCall === 1) return firstRuns.promise;
    return secondRuns.promise;
  });

  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    { rpc: { listRules, listRuns, status } },
  );

  await slot.findByText("Review checkout");
  expect(listRules).toHaveBeenCalledTimes(1);
  expect(status).toHaveBeenCalledTimes(1);
  expect(listRuns).toHaveBeenCalledTimes(1);

  // Burst 3 runs-changed events while the first listRuns is still in flight.
  await slot.behavior.emitRealtime("runs-changed", {});
  await slot.behavior.emitRealtime("runs-changed", {});
  await slot.behavior.emitRealtime("runs-changed", {});
  expect(listRuns).toHaveBeenCalledTimes(1);

  firstRuns.resolve({ runs: [] });
  await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(2));
  secondRuns.resolve({ runs: [] });

  // listRules and status were never refetched by runs-changed.
  expect(listRules).toHaveBeenCalledTimes(1);
  expect(status).toHaveBeenCalledTimes(1);
});

it("refreshes on realtime reconnect and ignores stale out-of-order responses", async () => {
  const app = await loadPluginApp(() => import("../app"));
  let rulesCall = 0;
  const staleRules = deferred<{ rules: (Rule & { dangerous: boolean })[] }>();
  const freshRules = deferred<{ rules: (Rule & { dangerous: boolean })[] }>();

  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      realtimeConnectionState: "connected",
      rpc: {
        listRules: () => {
          rulesCall += 1;
          return rulesCall === 1 ? staleRules.promise : freshRules.promise;
        },
        listRuns: () => ({ runs: [] }),
        status: () => ({ ghLogin: "test" }),
      },
    },
  );

  expect(rulesCall).toBe(1);
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  await slot.behavior.setRealtimeConnectionState("connected");
  await waitFor(() => expect(rulesCall).toBe(2));

  // Newer response resolves first, then older stale response resolves later.
  freshRules.resolve({ rules: [{ ...rule, name: "Fresh rule" }] });
  await slot.findByText("Fresh rule");

  staleRules.resolve({ rules: [{ ...rule, name: "Stale rule" }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(slot.getByText("Fresh rule")).toBeTruthy();
  expect(slot.queryByText("Stale rule")).toBeNull();
});

it("handles getRunComments and setRuleEnabled RPC failures without unhandled rejections", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const run: Run = {
    id: "run-1",
    ruleId: rule.id,
    ruleName: rule.name,
    repo: rule.repo,
    targetKind: "pull_request",
    prNumber: 42,
    prTitle: "Fix race",
    prAuthor: "octocat",
    headSha: "abc123",
    trigger: "ready_for_review",
    triggerEventId: null,
    status: "commented",
    mode: "live",
    detail: null,
    threadId: null,
    commentCount: 1,
    startedAt: Date.now(),
    finishedAt: Date.now(),
  };
  let commentAttempt = 0;
  const setRuleEnabled = vi.fn().mockRejectedValue(new Error("Toggle failed"));
  const getRunComments = vi.fn(() => {
    commentAttempt += 1;
    if (commentAttempt === 1) return Promise.reject(new Error("Comments unavailable"));
    return Promise.resolve({
      comments: [
        {
          githubId: "c1",
          kind: "inline",
          path: "src/app.ts",
          line: 10,
          url: null,
          bodyExcerpt: "Looks good",
          attribution: "slopcop",
        },
      ],
    });
  });

  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        listRules: () => ({ rules: [rule] }),
        listRuns: () => ({ runs: [run] }),
        status: () => ({ ghLogin: "test" }),
        setRuleEnabled,
        getRunComments,
      },
    },
  );

  // Toggle failure is caught gracefully.
  const toggle = await slot.findByRole("switch", { name: `Enable ${rule.name}` });
  fireEvent.click(toggle);
  await waitFor(() => expect(setRuleEnabled).toHaveBeenCalledOnce());

  // Switch to Activity tab and expand comments -> error + retry -> recovers.
  const activityTab = slot.getByRole("tab", { name: /activity/i });
  fireEvent.mouseDown(activityTab);
  fireEvent.click(activityTab);
  fireEvent.click(await slot.findByRole("button", { name: "1 comment" }));
  await slot.findByText("Comments unavailable");
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  await slot.findByText("Looks good");
});
