import { isolatedParameters } from "../../../.storybook/layout";
import { RegisteredSurface } from "../../../.storybook/host";
import { composerAction } from "../../../.storybook/surfaces";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";

const source = () => import("../app");

function staged(id: string, comment: string, element: string, routeLabel: string, seq: number) {
  return {
    id,
    sessionId: "s_story",
    comment,
    elementPath: `main > ${element}`,
    element,
    timestamp: 1792670400000,
    status: "pending",
    kind: "feedback",
    thread: [],
    bb: { route: "/settings", routeLabel, threadId: null, projectId: null, pluginId: null },
    createdAt: "2026-10-22T12:00:00Z",
    updatedAt: "2026-10-22T12:00:00Z",
    resolution: null,
    seq,
  };
}

const annotations = [
  staged(
    "a_retry",
    "The Retry action disappears below the fold at 360px. Keep it next to the offline message.",
    "button.retry",
    "Atlas review",
    1,
  ),
  staged("a_header", "Header wraps onto two lines in the narrow panel.", "header", "Settings", 2),
  staged("a_focus", "Return focus to the file that opened the picker.", "dialog", "Files", 3),
];

const host = (scope: object, rpc: Record<string, () => unknown>) => ({
  pluginId: "agentation",
  context: { threadId: "thr_story" },
  composer: { scope },
  rpc,
  sdk: { subscribe: () => () => {} },
});

const listed = { listStagedAnnotations: () => ({ annotations, threadTitles: {} }) };

async function opensList({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(
    await canvas.findByRole("button", { name: "3 annotations" }, { timeout: 15000 }),
  );
  const list = within(canvasElement.ownerDocument.body);
  await waitFor(() =>
    expect(
      list.getByText("Header wraps onto two lines in the narrow panel.", { selector: "p" }),
    ).toBeVisible(),
  );
  return list;
}

const meta = {
  title: "Components/Agentation/Staged annotations",
  component: RegisteredSurface,
  args: { source, select: (app) => composerAction(app, "staged-annotations") },
  parameters: {
    ...isolatedParameters,
    host: host({ kind: "thread", threadId: "thr_story" }, listed),
  },
} satisfies Meta<typeof RegisteredSurface>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A thread composer can send the batch or a single annotation to its thread. */
export const InThread: Story = {
  play: async (context) => {
    const list = await opensList(context);
    await expect(list.getByRole("button", { name: /Send all/ })).toBeEnabled();
    await expect(
      list.getAllByRole("button", { name: "Send annotation to this thread" }),
    ).toHaveLength(3);
  },
};

/** No thread exists yet, so the list only mentions annotations into the draft. */
export const NewThread: Story = {
  parameters: { host: host({ kind: "new-thread", projectId: "proj_story" }, listed) },
  play: async (context) => {
    const list = await opensList(context);
    await expect(list.getByRole("button", { name: /Mention all/ })).toBeEnabled();
    await expect(list.queryByRole("button", { name: /Send all/ })).toBeNull();
  },
};

let failedReads = 0;

/** A failed read becomes a Retry action that reads the list again. */
export const LoadFailed: Story = {
  parameters: {
    host: host(
      { kind: "thread", threadId: "thr_story" },
      {
        listStagedAnnotations: () => {
          failedReads += 1;
          throw new Error("Agentation server unavailable");
        },
      },
    ),
  },
  play: async ({ canvasElement }) => {
    const retry = await within(canvasElement).findByRole(
      "button",
      { name: "Retry loading annotations" },
      { timeout: 15000 },
    );
    await expect(retry).toBeVisible();
    await expect(retry.closest("[title]")).toHaveAttribute(
      "title",
      "Couldn't load annotations: Agentation server unavailable",
    );
    const before = failedReads;
    await userEvent.click(retry);
    await waitFor(() => expect(failedReads).toBe(before + 1));
  },
};

const actionButton = (canvasElement: HTMLElement) =>
  within(canvasElement).findByRole("button", { name: "3 annotations" }, { timeout: 15000 });
const listHeader = (canvasElement: HTMLElement) =>
  within(canvasElement.ownerDocument.body).queryByRole("button", { name: /Mention all/ });

/** Keyboard activation moves focus into the list so every action is reachable. */
export const KeyboardOpen: Story = {
  play: async ({ canvasElement }) => {
    (await actionButton(canvasElement)).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(listHeader(canvasElement)).toBeVisible());
    const content = canvasElement.ownerDocument.querySelector(
      "[data-radix-popper-content-wrapper]",
    );
    await waitFor(() =>
      expect(content?.contains(canvasElement.ownerDocument.activeElement)).toBe(true),
    );
    await userEvent.tab();
    await expect(content?.contains(canvasElement.ownerDocument.activeElement)).toBe(true);
  },
};

/** Clicking a hover preview keeps the list open after the pointer leaves. */
export const PinnedByClick: Story = {
  play: async ({ canvasElement }) => {
    const trigger = await actionButton(canvasElement);
    await userEvent.hover(trigger);
    await waitFor(() => expect(listHeader(canvasElement)).toBeVisible());
    await userEvent.click(trigger);
    await userEvent.unhover(trigger);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(listHeader(canvasElement)).toBeVisible();
  },
};

/** A hover preview never takes focus from the draft, even as it closes. */
export const HoverKeepsDraftFocus: Story = {
  play: async ({ canvasElement }) => {
    const draft = canvasElement.ownerDocument.createElement("textarea");
    draft.setAttribute("aria-label", "Draft");
    canvasElement.append(draft);
    draft.focus();
    const trigger = await actionButton(canvasElement);
    await userEvent.hover(trigger);
    await waitFor(() => expect(listHeader(canvasElement)).toBeVisible());
    await expect(draft).toHaveFocus();
    await userEvent.unhover(trigger);
    await waitFor(() => expect(listHeader(canvasElement)).toBeNull());
    await expect(draft).toHaveFocus();
    draft.remove();
  },
};
