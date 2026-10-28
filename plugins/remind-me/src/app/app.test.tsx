import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import type { ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import type { Reminder } from "../shared/reminder.ts";

installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { cleanup, fireEvent } = await import("@testing-library/react");
const { pluginQueryClient } = await import("@bb-kit/core/rpc/query");
beforeEach(() => pluginQueryClient.clear());
afterEach(cleanup);

const reminder: Reminder = {
  id: "71e25fe5-c24c-40d5-92b1-6f7c5fe28e90",
  title: "Review keyboard navigation",
  body: "Next step: test Tab and Enter.",
  sourceThreadId: "thr_source",
  createdAt: "2026-10-19T12:00:00Z",
};
async function renderReminders(page: boolean) {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const options = {
    rpc: { list: () => ({ reminders: [reminder] }) },
    composer: { text: "Keep my draft." },
  };
  if (page) {
    const registration = app.navPanels[0];
    if (!registration) throw new Error("Missing reminders page");
    return renderSlot(registration, { subPath: "" }, options);
  }
  const registration = app.tabs.find(
    (tab) =>
      tab.id === "reminders" && tab.context.kind === "thread" && tab.availability === "action",
  );
  if (!registration) throw new Error("Missing reminders panel");
  const component = registration.component as ComponentType<ExperimentalThreadActionTabProps>;
  return renderSlot({ component }, { threadId: "thr_target", params: null }, options);
}

test("adds a saved note to the thread draft without submitting it or navigating away", async () => {
  const slot = await renderReminders(false);
  fireEvent.click(
    await slot.findByRole("button", { name: "Add Review keyboard navigation to composer" }),
  );
  expect(slot.inspection.composer.text).toBe(
    "Keep my draft.\n\nReview keyboard navigation\n\nNext step: test Tab and Enter.\n\nSource: @thread:thr_source",
  );
  expect(slot.inspection.composer.focusCount).toBe(1);
  expect(slot.inspection.composer.submits).toEqual([]);
  expect(slot.inspection.navigateCalls).toEqual([]);
  expect(slot.getByText("Review keyboard navigation")).toBeTruthy();
});

test("the separate reminders page appends to the new-thread draft before opening it", async () => {
  const slot = await renderReminders(true);
  fireEvent.click(
    await slot.findByRole("button", { name: "Add Review keyboard navigation to composer" }),
  );
  expect(slot.inspection.composer.text).toStartWith("Keep my draft.\n\nReview keyboard navigation");
  expect(slot.inspection.navigateCalls).toEqual([
    { method: "toCompose", options: { focusPrompt: true } },
  ]);
});

test("search finds saved body text and shows an empty result for unmatched text", async () => {
  const slot = await renderReminders(false);
  await slot.findByText(reminder.title);
  fireEvent.change(slot.getByRole("searchbox"), { target: { value: "Enter" } });
  expect(slot.getByText(reminder.title)).toBeTruthy();
  fireEvent.change(slot.getByRole("searchbox"), { target: { value: "missing" } });
  expect(slot.queryByText(reminder.title)).toBeNull();
  expect(slot.getByText("No matching reminders.")).toBeTruthy();
});

test("the saved reminder card in chat adds the persisted note without sending", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const registration = app.messageDirectives[0];
  if (!registration) throw new Error("Missing reminder card");
  const slot = renderSlot(
    registration,
    {
      attributes: { id: reminder.id },
      source: `::reminder{id="${reminder.id}"}`,
      message: { id: "msg_1", threadId: "thr_target", turnId: null, projectId: null },
      openWorkspaceFile: null,
    },
    {
      rpc: { get: () => ({ reminder }) },
      composer: { text: "Existing draft." },
    },
  );
  fireEvent.click(
    await slot.findByRole("button", { name: "Add Review keyboard navigation to composer" }),
  );
  expect(slot.inspection.composer.text).toStartWith(
    "Existing draft.\n\nReview keyboard navigation",
  );
  expect(slot.inspection.composer.submits).toEqual([]);
});
