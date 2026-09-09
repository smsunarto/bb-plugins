import { expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { CHANGED_CHANNEL, type LatestTurn } from "../src/shared/contract.ts";
installDom();
// jsdom has no constructable stylesheets. Exercise Pierre's real components without CSS layout.
if (typeof CSSStyleSheet.prototype.replaceSync !== "function") {
  Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", {
    configurable: true,
    value() {},
  });
}
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

const first: LatestTurn = {
  turnId: "turn-1",
  anchorId: "message-1",
  patch: null,
  limited: false,
  changes: [
    { id: "edit-1", path: "first.ts", patch: "@@ -1 +1 @@\n-old\n+new\n", added: 1, removed: 1 },
  ],
};

test("inserts outside message prose, replaces the latest preview, clears empty turns, and cleans up", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  expect(captured.messageDirectives).toEqual([]);
  expect(captured.messageActions).toEqual([]);
  expect(captured.composerCustomizations).toEqual([]);
  const registration = captured.threadHeaderActions[0]!;
  const host = document.createElement("div");
  host.innerHTML =
    '<div data-timeline-row-id="message-1"><div data-message-column><p>Original answer.</p></div></div><div data-timeline-row-id="message-2"><div data-message-column><p>Second answer.</p></div></div>';
  document.body.append(host);
  let turn = first;
  const slot = renderSlot(
    registration,
    { threadId: "thread-1", projectId: "p", isCompactViewport: false },
    { rpc: { latestTurn: async () => ({ turn }) } },
  );
  try {
    await waitFor(() => expect(host.querySelectorAll("[data-last-turn-id]").length).toBe(1));
    const prose = host.querySelector("[data-message-column]")!;
    expect(prose.textContent).toBe("Original answer.");
    expect(prose.querySelector("[data-last-turn-diff-portal]")).toBeNull();
    expect(
      host
        .querySelector("[data-last-turn-id]")
        ?.closest("[data-timeline-row-id]")
        ?.getAttribute("data-timeline-row-id"),
    ).toBe("message-1");
    turn = { ...first, turnId: "turn-2", anchorId: "message-2" };
    await slot.behavior.emitRealtime(CHANGED_CHANNEL, { threadId: "thread-1" });
    await waitFor(() =>
      expect(host.querySelector("[data-last-turn-id]")?.getAttribute("data-last-turn-id")).toBe(
        "turn-2",
      ),
    );
    expect(
      host.querySelector('[data-timeline-row-id="message-1"] [data-last-turn-diff-portal]'),
    ).toBeNull();
    turn = { ...turn, changes: [] };
    await slot.behavior.emitRealtime(CHANGED_CHANNEL, { threadId: "thread-1" });
    await waitFor(() => expect(host.querySelector("[data-last-turn-id]")).toBeNull());
    expect(prose.textContent).toBe("Original answer.");
  } finally {
    slot.unmount();
    expect(host.querySelector("[data-last-turn-diff-portal]")).toBeNull();
    host.remove();
  }
});

test("bulk toggles follow individual rows and reset when the latest turn changes", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const host = document.createElement("div");
  host.innerHTML = '<div data-timeline-row-id="message-1"><p>Original answer.</p></div>';
  document.body.append(host);
  let turn: LatestTurn = {
    ...first,
    changes: [
      { ...first.changes[0]!, patch: null },
      { ...first.changes[0]!, id: "edit-2", path: "second.ts", patch: null },
    ],
  };
  const slot = renderSlot(
    captured.threadHeaderActions[0]!,
    { threadId: "thread-1", projectId: "p", isCompactViewport: false },
    { rpc: { latestTurn: async () => ({ turn }) } },
  );
  const ui = within(host);
  const openCount = () => host.querySelectorAll('button[aria-expanded="true"]').length;
  try {
    fireEvent.click(await ui.findByRole("button", { name: "Expand all" }));
    expect(openCount()).toBe(2);
    expect(ui.getAllByText("No text diff recorded for this change.")).toHaveLength(2);

    fireEvent.click(ui.getByRole("button", { name: "Collapse first.ts" }));
    expect(openCount()).toBe(1);
    fireEvent.click(ui.getByRole("button", { name: "Collapse all" }));
    expect(openCount()).toBe(0);
    expect(ui.queryByText("No text diff recorded for this change.")).toBeNull();

    fireEvent.click(ui.getByRole("button", { name: "Expand first.ts" }));
    expect(openCount()).toBe(1);
    expect(ui.getByRole("button", { name: "Collapse all" })).toBeTruthy();

    turn = { ...turn, turnId: "turn-2" };
    await slot.behavior.emitRealtime(CHANGED_CHANNEL, { threadId: "thread-1" });
    await ui.findByRole("button", { name: "Expand all" });
    expect(openCount()).toBe(0);
  } finally {
    slot.unmount();
    host.remove();
  }
});

test("Pierre owns the file header while expanded patches use the host Diff component", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const host = document.createElement("div");
  host.innerHTML = '<div data-timeline-row-id="message-1"><p>Original answer.</p></div>';
  document.body.append(host);
  const patch = [
    "diff --git a/before.ts b/after.ts",
    "similarity index 50%",
    "rename from before.ts",
    "rename to after.ts",
    "--- a/before.ts",
    "+++ b/after.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const turn: LatestTurn = {
    ...first,
    changes: [
      { ...first.changes[0]!, path: "after.ts", patch },
      { ...first.changes[0]!, id: "edit-2" },
    ],
  };
  const slot = renderSlot(
    captured.threadHeaderActions[0]!,
    { threadId: "thread-1", projectId: "p", isCompactViewport: false },
    { rpc: { latestTurn: async () => ({ turn }) } },
  );
  const ui = within(host);
  try {
    const toggle = await ui.findByRole("button", { name: "Expand after.ts" });
    expect(ui.queryByTestId("bb-diff")).toBeNull();
    const header = host.querySelector(".last-turn-diff-file-header")!;
    await waitFor(() =>
      expect(header.shadowRoot?.querySelector("[data-title]")?.textContent).toBe("after.ts"),
    );
    expect(header.shadowRoot?.querySelector("[data-prev-name]")?.textContent).toBe("before.ts");
    expect(header.shadowRoot?.querySelector("[data-additions-count]")?.textContent).toBe("+1");
    expect(header.shadowRoot?.querySelector("[data-deletions-count]")?.textContent).toBe("-1");

    fireEvent.click(toggle);
    expect(ui.getByTestId("bb-diff").textContent).toBe(patch);
    expect(header.shadowRoot?.querySelector("[data-line]")).toBeNull();
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.hidden).toBe(false);
    fireEvent.click(ui.getByRole("button", { name: "Collapse after.ts" }));
    expect(ui.queryByTestId("bb-diff")).toBeNull();

    fireEvent.click(ui.getByRole("button", { name: "Expand first.ts" }));
    expect(ui.getByTestId("bb-diff").textContent).toBe(first.changes[0]!.patch!);
  } finally {
    slot.unmount();
    host.remove();
  }
});

test("a missing or virtualized target does not attach a diff to another message", async () => {
  const { mountDiffPortal } = await import("../src/app/portal.ts");
  const host = document.createElement("div");
  host.innerHTML = '<div data-timeline-row-id="other"></div>';
  document.body.append(host);
  let target: HTMLElement | null = null;
  const dispose = mountDiffPortal(host, "expected", (element) => {
    target = element;
  });
  expect(host.querySelector("[data-last-turn-diff-portal]")).toBeNull();
  const row = document.createElement("div");
  row.dataset.timelineRowId = "expected";
  host.append(row);
  await waitFor(() => expect(row.querySelector("[data-last-turn-diff-portal]")).toBe(target));
  row.remove();
  dispose();
  host.remove();
});
