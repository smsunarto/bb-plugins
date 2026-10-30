import { afterEach, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";
import type { ComposerMention } from "@get-bb/plugin-sdk/app";
import { createElement, Fragment } from "react";

installDom();
// installDom keeps node's Event classes; Radix dispatches its custom events on
// jsdom nodes, which accept only jsdom's own.
const jsdomWindow = window as unknown as { Event: typeof Event; CustomEvent: typeof CustomEvent };
Object.assign(globalThis, { Event: jsdomWindow.Event, CustomEvent: jsdomWindow.CustomEvent });
// jsdom has no matchMedia; the vendored Dialog reads it to pick its layout.
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { useComposer } = await import("@get-bb/plugin-sdk/app");
const { act, cleanup, fireEvent, screen, waitFor } = await import("@testing-library/react");
const { AgentationStagedAnnotationsAction } =
  await import("../components/staged-annotations-action.tsx");
const { ANNOTATION_MENTION_PROVIDER, annotationMentionItemId } =
  await import("../lib/staging-display.ts");
afterEach(cleanup);

// The list opens from the pill into a portal outside the slot container.
async function openList(
  slot: { findByRole: (role: string, options: { name: string }) => Promise<HTMLElement> },
  count: number,
) {
  fireEvent.click(
    await slot.findByRole("button", { name: `${count} annotation${count === 1 ? "" : "s"}` }),
  );
  return screen;
}

const PLUGIN_ID = "agentation";
const THREAD_ID = "thr_review";

function staged(id: string, comment: string) {
  return {
    id,
    comment,
    element: "button.save",
    elementPath: "main > button.save",
    timestamp: 1,
    sessionId: "ses_1",
    status: "pending",
    kind: "feedback",
    thread: [],
    bb: { route: "/settings", routeLabel: "Settings", threadId: null, pluginId: null },
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    resolution: null,
    seq: 1,
  };
}

function annotationPill(
  annotationId: string,
  from: number,
): Extract<ComposerMention, { kind: "plugin" }> {
  const label = `[Settings] ${annotationId}`;
  return {
    kind: "plugin",
    pluginId: PLUGIN_ID,
    provider: ANNOTATION_MENTION_PROVIDER,
    id: annotationMentionItemId(annotationId, THREAD_ID),
    label,
    icon: null,
    from,
    to: from + label.length + 1,
  };
}

// A composer that offers a context row, as the T3 Composer draws it.
function ComposerWithContextRow() {
  return createElement(
    "form",
    { "data-promptbox": "" },
    createElement(
      "div",
      { "data-t3-attachments": "" },
      createElement("span", { "data-composer-context-slot": "" }),
    ),
    createElement(
      "div",
      { "data-plugin-composer-action": "" },
      createElement(AgentationStagedAnnotationsAction),
    ),
  );
}

function renderAction(options: {
  text?: string;
  mentions?: readonly ComposerMention[];
  newThread?: boolean;
  submittingBlockedReason?: string;
  contextRow?: boolean;
  rpc: Record<string, (input: unknown) => unknown>;
}) {
  return renderSlot(
    { component: options.contextRow ? ComposerWithContextRow : AgentationStagedAnnotationsAction },
    {},
    {
      pluginId: PLUGIN_ID,
      composer: {
        scope: options.newThread
          ? { kind: "new-thread", projectId: "prj_1" }
          : { kind: "thread", threadId: THREAD_ID },
        text: options.text ?? "",
        mentions: options.mentions ?? [],
        submittingBlockedReason: options.submittingBlockedReason,
      },
      rpc: options.rpc,
    },
  );
}

test("a composer's context row shows the batch as a chip of the annotations still waiting", async () => {
  const slot = renderAction({
    contextRow: true,
    text: `@${annotationPill("ann_1", 0).label} `,
    mentions: [annotationPill("ann_1", 0)],
    rpc: {
      listStagedAnnotations: () => ({
        annotations: [staged("ann_1", "Save is misaligned"), staged("ann_2", "Wrong color")],
        threadTitles: {},
      }),
    },
  });
  const chip = await slot.findByRole("button", { name: "1 annotation" });
  expect(chip.textContent).toBe("1 annotation");
  expect(chip.closest("[data-composer-context-slot]")).not.toBeNull();
  // Plugin styles reach the portaled chip through its own root marker.
  expect(chip.closest(`[data-bb-plugin="${PLUGIN_ID}"]`)).not.toBeNull();
  const cell = slot.container.querySelector("[data-plugin-composer-action]")!;
  expect(cell.querySelector('[data-composer-context-anchor="portaled"]')).not.toBeNull();
  expect(cell.querySelector("[data-agentation-staging-action]")).toBeNull();

  const list = await openList(slot, 1);
  expect(
    await list.findAllByRole("button", { name: "Mention annotation in composer" }),
  ).toHaveLength(1);
});

test("a context row stays empty while no annotation is waiting", async () => {
  const slot = renderAction({
    contextRow: true,
    text: `@${annotationPill("ann_1", 0).label} `,
    mentions: [annotationPill("ann_1", 0)],
    rpc: {
      listStagedAnnotations: () => ({
        annotations: [staged("ann_1", "Save is misaligned")],
        threadTitles: {},
      }),
    },
  });
  const contextSlot = slot.container.querySelector("[data-composer-context-slot]")!;
  // The composer hides its row only while the slot has no element children.
  await waitFor(() =>
    expect(
      slot.container.querySelector('[data-composer-context-anchor="portaled"]'),
    ).not.toBeNull(),
  );
  await act(async () => {});
  expect(contextSlot.childElementCount).toBe(0);
});

test("mentioning every waiting annotation from the chip still focuses the composer", async () => {
  const slot = renderAction({
    contextRow: true,
    text: "Fix",
    rpc: {
      listStagedAnnotations: () => ({
        annotations: [staged("ann_1", "Save is misaligned"), staged("ann_2", "Wrong color")],
        threadTitles: {},
      }),
    },
  });
  const list = await openList(slot, 2);
  fireEvent.click(await list.findByRole("button", { name: /Mention all/ }));

  await waitFor(() => expect(slot.inspection.composer.focusCount).toBe(1));
  expect(slot.inspection.composer.draft.mentions).toHaveLength(2);
  expect(slot.queryByRole("button", { name: "2 annotations" })).toBeNull();
});

test("the mention button appends the annotation pill after the draft and focuses it", async () => {
  const slot = renderAction({
    text: "Fix",
    rpc: {
      listStagedAnnotations: () => ({
        annotations: [staged("ann_1", "Save is misaligned")],
        threadTitles: {},
      }),
    },
  });
  const list = await openList(slot, 1);
  fireEvent.click(await list.findByRole("button", { name: "Mention annotation in composer" }));

  // The list closes first, then hands focus back to the composer.
  await waitFor(() => expect(slot.inspection.composer.focusCount).toBe(1));
  const { draft, focusCount } = slot.inspection.composer;
  expect(draft.mentions).toHaveLength(1);
  const [pill] = draft.mentions;
  expect(pill).toMatchObject({
    kind: "plugin",
    pluginId: PLUGIN_ID,
    provider: ANNOTATION_MENTION_PROVIDER,
    id: annotationMentionItemId("ann_1", THREAD_ID),
  });
  expect(draft.text.slice(0, pill!.from)).toBe("Fix ");
  expect(draft.text.slice(pill!.to)).toBe(" ");
  expect(focusCount).toBe(1);
});

test("sending an annotation removes only its pill and keeps later mentions aligned", async () => {
  const sent = annotationPill("ann_1", 4);
  const kept = annotationPill("ann_2", 0);
  const thread: ComposerMention = {
    kind: "thread",
    threadId: "thr_other",
    label: "Other",
    from: 0,
    to: "@thread:thr_other".length,
  };
  const prefix = "see ";
  const sentText = `@${sent.label}`;
  const middle = " and ";
  const keptText = `@${kept.label}`;
  const threadText = "@thread:thr_other";
  const text = `${prefix}${sentText}${middle}${keptText} ${threadText}`;
  const keptFrom = prefix.length + sentText.length + middle.length;
  const threadFrom = keptFrom + keptText.length + 1;

  let annotations = [staged("ann_1", "Save is misaligned"), staged("ann_2", "Wrong color")];
  const slot = renderAction({
    text,
    mentions: [
      sent,
      { ...kept, from: keptFrom, to: keptFrom + keptText.length },
      { ...thread, from: threadFrom, to: threadFrom + threadText.length },
    ],
    rpc: {
      listStagedAnnotations: () => ({ annotations, threadTitles: {} }),
      sendStagedAnnotations: () => {
        annotations = annotations.filter((annotation) => annotation.id !== "ann_1");
        return { outcome: "sent", sentIds: ["ann_1"], remainingCount: 1, message: "Sent 1." };
      },
    },
  });
  const list = await openList(slot, 2);
  const [sendFirst] = await list.findAllByRole("button", {
    name: "Send annotation to this thread",
  });
  await act(async () => {
    fireEvent.click(sendFirst!);
  });

  await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(2));
  const { draft } = slot.inspection.composer;
  expect(draft.text).toBe(`${prefix}${middle}${keptText} ${threadText}`);
  const [keptPill, threadPill] = draft.mentions;
  expect(keptPill).toMatchObject({ id: kept.id, kind: "plugin" });
  expect(draft.text.slice(keptPill!.from, keptPill!.to)).toBe(keptText);
  expect(draft.text.slice(threadPill!.from, threadPill!.to)).toBe(threadText);
});

test("a submitted draft re-reads the staged list at once", async () => {
  // Stand in for the user pressing Enter in the same composer.
  function ActionWithSubmit() {
    const composer = useComposer();
    return createElement(
      Fragment,
      null,
      createElement(AgentationStagedAnnotationsAction),
      createElement("button", { type: "button", onClick: () => void composer.submit() }, "Enter"),
    );
  }
  let reads = 0;
  const slot = renderSlot(
    { component: ActionWithSubmit },
    {},
    {
      pluginId: PLUGIN_ID,
      composer: { scope: { kind: "thread", threadId: THREAD_ID }, text: "Ship it" },
      rpc: {
        listStagedAnnotations: () => {
          reads += 1;
          return { annotations: [staged("ann_1", "Save is misaligned")], threadTitles: {} };
        },
      },
    },
  );
  await slot.findByRole("button", { name: "1 annotation" });
  const before = reads;

  await act(async () => {
    fireEvent.click(slot.getByRole("button", { name: "Enter" }));
  });

  expect(slot.inspection.composer.submits).toHaveLength(1);
  await waitFor(() => expect(reads).toBe(before + 1));
});

test("the new-thread composer offers mentions and send all", async () => {
  const slot = renderAction({
    newThread: true,
    text: "Fix",
    mentions: [],
    rpc: {
      listStagedAnnotations: () => ({
        annotations: [staged("ann_1", "Save is misaligned"), staged("ann_2", "Wrong color")],
        threadTitles: {},
      }),
    },
  });
  const list = await openList(slot, 2);
  await list.findByRole("button", { name: "Mention all" });
  await list.findByRole("button", { name: "Send all" });
  expect(list.queryByRole("button", { name: "Send annotation to this thread" })).toBeNull();

  const [mentionFirst] = list.getAllByRole("button", { name: "Mention annotation in composer" });
  fireEvent.click(mentionFirst!);
  await waitFor(() => expect(list.queryByRole("button", { name: /Mention all/ })).toBeNull());
  await openList(slot, 2);
  fireEvent.click(await list.findByRole("button", { name: /Mention all/ }));

  // The pills name no thread; the dispatch that creates the thread assigns them.
  const { draft } = slot.inspection.composer;
  expect(draft.mentions.map((mention) => mention.kind === "plugin" && mention.id)).toEqual([
    annotationMentionItemId("ann_1", null),
    annotationMentionItemId("ann_2", null),
  ]);
  expect(draft.text.startsWith("Fix ")).toBe(true);
});

test("send all submits the new-thread draft with every staged annotation", async () => {
  const slot = renderAction({
    newThread: true,
    rpc: {
      listStagedAnnotations: () => ({
        annotations: [staged("ann_1", "Save is misaligned"), staged("ann_2", "Wrong color")],
        threadTitles: {},
      }),
    },
  });
  const list = await openList(slot, 2);
  await act(async () => {
    fireEvent.click(await list.findByRole("button", { name: "Send all" }));
  });

  expect(slot.inspection.composer.submits).toHaveLength(1);
  expect(slot.inspection.composer.draft.text).toBe("");
  expect(slot.inspection.rpcCalls.some((call) => call.method === "sendStagedAnnotations")).toBe(
    false,
  );
});

test("send all sends the complete staged batch to an existing thread", async () => {
  let annotations = [staged("ann_1", "Save is misaligned"), staged("ann_2", "Wrong color")];
  const slot = renderAction({
    text: "Keep this draft",
    rpc: {
      listStagedAnnotations: () => ({ annotations, threadTitles: {} }),
      sendStagedAnnotations: () => {
        annotations = [];
        return {
          outcome: "sent",
          sentIds: ["ann_1", "ann_2"],
          remainingCount: 0,
          message: "Sent 2.",
        };
      },
    },
  });
  const list = await openList(slot, 2);
  await act(async () => {
    fireEvent.click(await list.findByRole("button", { name: "Send all" }));
  });

  expect(slot.inspection.rpcCalls).toContainEqual({
    method: "sendStagedAnnotations",
    input: { annotationIds: ["ann_1", "ann_2"], threadId: THREAD_ID },
  });
  expect(slot.inspection.composer.draft.text).toBe("Keep this draft");
  await waitFor(() => expect(slot.queryByRole("button", { name: "2 annotations" })).toBeNull());
});

test("a blocked new-thread send retains the draft with every annotation pill for retry", async () => {
  const slot = renderAction({
    newThread: true,
    text: "Fix these",
    submittingBlockedReason: "Choose a provider",
    rpc: {
      listStagedAnnotations: () => ({
        annotations: [staged("ann_1", "Save is misaligned"), staged("ann_2", "Wrong color")],
        threadTitles: {},
      }),
    },
  });
  const list = await openList(slot, 2);
  await act(async () => {
    fireEvent.click(await list.findByRole("button", { name: "Send all" }));
  });

  expect(slot.inspection.composer.submits).toHaveLength(0);
  expect(slot.inspection.composer.draft.text.startsWith("Fix these ")).toBe(true);
  expect(
    slot.inspection.composer.draft.mentions.flatMap((mention) =>
      mention.kind === "plugin" ? [mention.id] : [],
    ),
  ).toEqual([annotationMentionItemId("ann_1", null), annotationMentionItemId("ann_2", null)]);
});
