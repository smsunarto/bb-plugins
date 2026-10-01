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

test("temporary files are absent from the card and its totals", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const host = document.createElement("div");
  host.innerHTML = '<div data-timeline-row-id="message-1"><p>Original answer.</p></div>';
  document.body.append(host);
  let turn: LatestTurn = {
    ...first,
    changes: [
      { ...first.changes[0]!, patch: null },
      {
        id: "tmp",
        path: "/tmp/review.txt",
        workspace: "tmp",
        patch: null,
        added: 40,
        removed: 20,
      },
      { id: "private-tmp", path: "/private/tmp/check.txt", patch: null, added: 10, removed: 5 },
    ],
  };
  const slot = renderSlot(
    captured.threadHeaderActions[0]!,
    { threadId: "thread-1", projectId: "p", isCompactViewport: false },
    { rpc: { latestTurn: async () => ({ turn }) } },
  );
  try {
    const ui = within(host);
    await ui.findByText("1 file changed");
    const heading = within(host.querySelector<HTMLElement>(".last-turn-diff-heading")!);
    expect(heading.getByText("+1")).toBeTruthy();
    expect(heading.getByText("−1")).toBeTruthy();
    expect(ui.queryByText("review.txt")).toBeNull();
    expect(ui.queryByText("/private/tmp/check.txt")).toBeNull();
    fireEvent.click(ui.getByRole("button", { name: "Expand all" }));
    expect(ui.getAllByText("No text diff recorded for this change.")).toHaveLength(1);
    turn = { ...turn, changes: turn.changes.slice(1) };
    await slot.behavior.emitRealtime(CHANGED_CHANNEL, { threadId: "thread-1" });
    await waitFor(() => expect(host.querySelector("[data-last-turn-id]")).toBeNull());
  } finally {
    slot.unmount();
    host.remove();
  }
});

test("retains the preview on refresh, replaces newer changes, clears absent data, and cleans up", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  expect(captured.messageDirectives).toEqual([]);
  expect(captured.messageActions).toEqual([]);
  expect(captured.composerCustomizations).toEqual([]);
  const registration = captured.threadHeaderActions[0]!;
  const host = document.createElement("div");
  host.innerHTML =
    '<div data-timeline-row-id="message-1"><div data-message-column><p>Original answer.</p></div></div><div data-timeline-row-id="message-2"><div data-message-column><p>Second answer.</p></div></div>';
  document.body.append(host);
  let turn: LatestTurn | null = first;
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
    fireEvent.click(within(host).getByRole("button", { name: "Expand all" }));
    turn = { ...first };
    await slot.behavior.emitRealtime(CHANGED_CHANNEL, { threadId: "thread-1" });
    await waitFor(() =>
      expect(within(host).getByRole("button", { name: "Collapse all" })).toBeTruthy(),
    );
    expect(host.querySelectorAll("[data-last-turn-id]")).toHaveLength(1);
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
    turn = null;
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
    expect(ui.queryByText(/Edit \d+ of/)).toBeNull();
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

test("other agents' changes are labeled and left out of the totals", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const host = document.createElement("div");
  host.innerHTML =
    '<div data-timeline-row-id="message-1"><div data-message-column><p>Answer.</p></div></div>';
  document.body.append(host);
  const turn: LatestTurn = {
    ...first,
    changes: [],
    otherPatch:
      "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1,2 @@\n b\n+from agent B\n",
  };
  const slot = renderSlot(
    captured.threadHeaderActions[0]!,
    { threadId: "thread-1", projectId: "p", isCompactViewport: false },
    { rpc: { latestTurn: async () => ({ turn }) } },
  );
  try {
    await waitFor(() => expect(host.querySelector("[data-last-turn-id]")).not.toBeNull());
    const card = within(host.querySelector<HTMLElement>("[data-last-turn-id]")!);
    expect(card.getByRole("heading", { name: /^Other agents in this checkout/ })).toBeTruthy();
    expect(card.getByText("0 files changed")).toBeTruthy();
    expect(card.getByText("+0")).toBeTruthy();
    // Collapsed by default: the files stay hidden and Expand all has nothing to open.
    const group = card.getByRole("button", { name: "Other agents in this checkout 1 file" });
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(card.queryByRole("button", { name: "Expand b.ts" })).toBeNull();
    expect(card.queryByRole("button", { name: "Expand all" })).toBeNull();
    fireEvent.click(group);
    expect(group.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(card.getByRole("button", { name: "Expand b.ts" })).toBeTruthy());
    expect(card.getByRole("button", { name: "Expand all" })).toBeTruthy();
  } finally {
    slot.unmount();
    host.remove();
  }
});

test("bulk toggles leave the collapsed others group's files alone", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const host = document.createElement("div");
  host.innerHTML =
    '<div data-timeline-row-id="message-1"><div data-message-column><p>Answer.</p></div></div>';
  document.body.append(host);
  const turn: LatestTurn = {
    ...first,
    otherPatch:
      "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1,2 @@\n b\n+from agent B\n",
  };
  const slot = renderSlot(
    captured.threadHeaderActions[0]!,
    { threadId: "thread-bulk", projectId: "p", isCompactViewport: false },
    { rpc: { latestTurn: async () => ({ turn }) } },
  );
  try {
    await waitFor(() => expect(host.querySelector("[data-last-turn-id]")).not.toBeNull());
    const card = within(host.querySelector<HTMLElement>("[data-last-turn-id]")!);
    const group = card.getByRole("button", { name: "Other agents in this checkout 1 file" });
    fireEvent.click(group);
    fireEvent.click(await card.findByRole("button", { name: "Expand b.ts" }));
    fireEvent.click(group);
    fireEvent.click(card.getByRole("button", { name: "Expand all" }));
    expect(card.getByRole("button", { name: "Collapse first.ts" })).toBeTruthy();
    fireEvent.click(group);
    expect(await card.findByRole("button", { name: "Collapse b.ts" })).toBeTruthy();
    fireEvent.click(group);
    fireEvent.click(card.getByRole("button", { name: "Collapse all" }));
    fireEvent.click(group);
    expect(await card.findByRole("button", { name: "Collapse b.ts" })).toBeTruthy();
    expect(card.getByRole("button", { name: "Expand first.ts" })).toBeTruthy();
  } finally {
    slot.unmount();
    host.remove();
  }
});

test("a workspace labeled 'other' is not mistaken for other agents' changes", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const host = document.createElement("div");
  host.innerHTML =
    '<div data-timeline-row-id="message-1"><div data-message-column><p>Answer.</p></div></div>';
  document.body.append(host);
  const turn: LatestTurn = {
    ...first,
    changes: [{ ...first.changes[0]!, id: "edit-2", path: "elsewhere.ts", workspace: "other" }],
  };
  const slot = renderSlot(
    captured.threadHeaderActions[0]!,
    { threadId: "thread-other-label", projectId: "p", isCompactViewport: false },
    { rpc: { latestTurn: async () => ({ turn }) } },
  );
  try {
    await waitFor(() => expect(host.querySelector("[data-last-turn-id]")).not.toBeNull());
    const card = within(host.querySelector<HTMLElement>("[data-last-turn-id]")!);
    expect(card.getByRole("button", { name: "Expand elsewhere.ts" })).toBeTruthy();
    expect(card.queryByRole("button", { name: /^Other agents/ })).toBeNull();
  } finally {
    slot.unmount();
    host.remove();
  }
});

test("successive edits share one file entry and retain every recorded patch", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const host = document.createElement("div");
  host.innerHTML = '<div data-timeline-row-id="message-1"><p>Answer.</p></div>';
  document.body.append(host);
  const turn: LatestTurn = {
    ...first,
    changes: [
      {
        id: "a",
        path: "/ws/project/skill.md",
        relPath: "skill.md",
        workspace: "project",
        patch: "@@ -1 +1 @@\n-old\n+middle\n",
        added: 1,
        removed: 1,
      },
      {
        id: "b",
        path: "/ws/project/skill.md",
        relPath: "skill.md",
        workspace: "project",
        patch: "@@ -1 +1,2 @@\n-middle\n+final\n+extra\n",
        added: 2,
        removed: 1,
      },
    ],
  };
  const slot = renderSlot(
    captured.threadHeaderActions[0]!,
    { threadId: "thread-repeated", projectId: "p", isCompactViewport: false },
    { rpc: { latestTurn: async () => ({ turn }) } },
  );
  try {
    const ui = within(host);
    const toggle = await ui.findByRole("button", { name: "Expand skill.md" });
    expect(ui.getAllByRole("button", { name: "Expand skill.md" })).toHaveLength(1);
    expect(ui.getByText("1 file changed").textContent).toBe("1 file changed");
    expect(
      within(host.querySelector<HTMLElement>(".last-turn-diff-heading")!).getByText("+3")
        .textContent,
    ).toBe("+3");
    const header = host.querySelector(".last-turn-diff-file-header")!;
    await waitFor(() => expect(header.textContent).toContain("+3"));
    expect(header.textContent).toContain("-2");
    expect(header.textContent).toContain("2 edits");
    fireEvent.click(toggle);
    expect(ui.getByText("Edit 1 of 2").textContent).toBe("Edit 1 of 2");
    expect(ui.getByText("Edit 2 of 2").textContent).toBe("Edit 2 of 2");
    expect(ui.getAllByTestId("bb-diff").map((diff) => diff.textContent)).toEqual([
      "@@ -1 +1 @@\n-old\n+middle\n",
      "@@ -1 +1,2 @@\n-middle\n+final\n+extra\n",
    ]);
    fireEvent.click(ui.getByRole("button", { name: "Collapse all" }));
    expect(ui.queryAllByTestId("bb-diff")).toHaveLength(0);
    fireEvent.click(ui.getByRole("button", { name: "Expand all" }));
    expect(ui.getAllByTestId("bb-diff")).toHaveLength(2);
  } finally {
    slot.unmount();
    host.remove();
  }
});

test("matching paths in different workspace and attribution groups stay separate", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const host = document.createElement("div");
  host.innerHTML = '<div data-timeline-row-id="message-1"><p>Answer.</p></div>';
  document.body.append(host);
  const turn: LatestTurn = {
    ...first,
    changes: [
      { id: "own", path: "same.ts", patch: null, added: 1, removed: 0 },
      { id: "foreign", path: "same.ts", workspace: "elsewhere", patch: null, added: 2, removed: 0 },
      { id: "other", path: "same.ts", other: true, patch: null, added: 10, removed: 0 },
      { id: "other-again", path: "same.ts", other: true, patch: null, added: 20, removed: 0 },
    ],
  };
  const slot = renderSlot(
    captured.threadHeaderActions[0]!,
    { threadId: "thread-distinct-groups", projectId: "p", isCompactViewport: false },
    { rpc: { latestTurn: async () => ({ turn }) } },
  );
  try {
    const ui = within(host);
    await ui.findByText("2 files changed");
    expect(ui.getAllByRole("button", { name: "Expand same.ts" })).toHaveLength(2);
    expect(
      within(host.querySelector<HTMLElement>(".last-turn-diff-heading")!).getByText("+3")
        .textContent,
    ).toBe("+3");
    fireEvent.click(ui.getByRole("button", { name: "Other agents in this checkout 1 file" }));
    expect(ui.getAllByRole("button", { name: "Expand same.ts" })).toHaveLength(3);
    fireEvent.click(ui.getByRole("button", { name: "Expand all" }));
    expect(ui.getAllByText("No text diff recorded for this change.")).toHaveLength(4);
    expect(ui.getByText("Edit 2 of 2").textContent).toBe("Edit 2 of 2");
  } finally {
    slot.unmount();
    host.remove();
  }
});

test("a grouped Unity file keeps context and raw YAML on the matching edit", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const host = document.createElement("div");
  host.innerHTML = '<div data-timeline-row-id="message-1"><p>Answer.</p></div>';
  document.body.append(host);
  const turn: LatestTurn = {
    ...first,
    changes: [
      {
        id: "first",
        path: "Hero.prefab",
        patch: "@@ -1 +1 @@\n-old\n+middle\n",
        added: 1,
        removed: 1,
      },
      {
        id: "second",
        path: "Hero.prefab",
        patch: "@@ -1 +1 @@\n-middle\n+final\n",
        added: 1,
        removed: 1,
      },
    ],
    unity: {
      second: {
        groups: [
          {
            id: "hero",
            name: "Hero",
            hierarchy: "",
            status: "modified",
            components: [
              {
                id: "object",
                type: "GameObject",
                status: "modified",
                properties: [{ path: "m_IsActive", before: "1", after: "0" }],
              },
            ],
          },
        ],
        propertyCount: 1,
      },
    },
  };
  const slot = renderSlot(
    captured.threadHeaderActions[0]!,
    { threadId: "thread-unity-edits", projectId: "p", isCompactViewport: false },
    { rpc: { latestTurn: async () => ({ turn }) } },
  );
  try {
    const ui = within(host);
    fireEvent.click(await ui.findByRole("button", { name: "Expand Hero.prefab" }));
    expect(ui.getAllByTestId("bb-diff").map((diff) => diff.textContent)).toEqual([
      "@@ -1 +1 @@\n-old\n+middle\n",
    ]);
    const unity = within(ui.getByRole("region", { name: "Unity changes in Hero.prefab" }));
    expect(unity.getByText("Hero").textContent).toBe("Hero");
    expect(unity.getByText("1").textContent).toBe("1");
    expect(unity.getByText("0").textContent).toBe("0");
    fireEvent.click(unity.getByRole("button", { name: "Raw YAML" }));
    expect(ui.getAllByTestId("bb-diff").map((diff) => diff.textContent)).toEqual([
      "@@ -1 +1 @@\n-old\n+middle\n",
      "@@ -1 +1 @@\n-middle\n+final\n",
    ]);
  } finally {
    slot.unmount();
    host.remove();
  }
});
