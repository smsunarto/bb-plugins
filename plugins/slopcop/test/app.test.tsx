// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Rule } from "../lib/types";

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
  displayedRule = rule,
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
  fireEvent.change(slot.getByLabelText("Review instructions"), {
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
  fireEvent.change(slot.getByLabelText("Review instructions"), { target: { value: "Unsaved" } });
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
