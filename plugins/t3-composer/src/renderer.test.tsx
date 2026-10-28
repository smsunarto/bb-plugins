// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  ExperimentalComposerInput,
  ExperimentalComposerRendererApi,
} from "@get-bb/plugin-sdk/app";
import { SaveDraftAction } from "./SaveDraftAction";

// The SDK harness draws other plugins' actions as nothing; mark where BB's group mounts.
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...sdk,
    experimental_useComposerContributions: () => ({
      ...sdk.experimental_useComposerContributions(),
      Actions: () => <span data-testid="plugin-actions" />,
    }),
  };
});

async function mountComposer(
  inputOverrides: Partial<ExperimentalComposerInput> = {},
  scope: ExperimentalComposerRendererApi["view"]["scope"] = { kind: "new-thread", projectId: "p1" },
) {
  const run = vi.fn();
  const input: ExperimentalComposerInput = {
    surface: "new-thread",
    executionControls: <button type="button">Host model picker</button>,
    mentionTriggers: ["@"],
    commandTriggers: ["/"],
    resolveMentionLink: () => null,
    mentionMenuPlacement: "bottom",
    submission: {
      enter: {
        kind: "send",
        requiresInput: true,
        shortcut: { label: "Enter", ariaKeyshortcuts: "Enter" },
        run,
      },
      modifier: null,
      showModifierInMenu: false,
    },
    ...inputOverrides,
  };
  const renderer: ExperimentalComposerRendererApi = {
    input,
    view: {
      scope,
      layout: input.compact ? "compact" : "expanded",
      draft: { text: "A draft", isEmpty: false, attachmentCount: 0 },
      run: { isRunning: false, isSubmitting: false },
    },
    key: "new-thread:p1",
    inputLocked: false,
    focusComposerShortcut: null,
    decorationSources: [],
    threadLinks: { parse: () => null, cached: () => null, resolve: async () => {} },
    clipboard: {
      readMessage: () => null,
      readMessageImage: async () => new File([], "message.png"),
    },
    dispatchAppCommandKey: () => false,
    showError: vi.fn(),
    attachmentSrc: (path) => path,
  };
  const app = await loadPluginApp(() => import("../app"));
  const composer = app.composers[0];
  if (!composer) throw new Error("Composer replacement was not registered");
  const slot = renderSlot(
    composer,
    {},
    {
      composer: { scope, text: "A draft" },
      composerRenderer: renderer,
    },
  );
  return { slot, run, app, renderer, scope };
}

describe("T3 composer SDK integration", () => {
  it("places Save draft beside Submit, outside the model controls", async () => {
    const { slot } = await mountComposer();
    try {
      expect(slot.queryByRole("button", { name: "Send options" })).toBeNull();
      const actions = slot.container.querySelector("[data-t3-composer-save-action]");
      const rightCluster = actions?.closest(
        "[data-promptbox-standard-actions]:not([data-promptbox-expanded-only])",
      );
      expect(rightCluster?.querySelector("[data-promptbox-submit-group]")).toBeTruthy();
      expect(actions?.closest("[data-t3-composer-controls]")).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  }, 15000);

  it("shows plugin actions after the model controls, but not in compact composers", async () => {
    const expanded = await mountComposer();
    try {
      const actions = await expanded.slot.findByTestId("plugin-actions");
      const modelControls = expanded.slot.container.querySelector("[data-t3-composer-controls]");
      expect(modelControls?.nextElementSibling).toBe(actions);
      expect(
        actions
          .closest("[data-promptbox-standard-actions]")
          ?.querySelector("[data-promptbox-submit-group]"),
      ).toBeNull();
    } finally {
      expanded.slot.lifecycle.unmount();
    }
    const compact = await mountComposer({
      compact: { when: "always", placeholder: "Follow up" },
    });
    try {
      expect(compact.slot.container.querySelector("[data-t3-composer-save-action]")).toBeTruthy();
      expect(compact.slot.queryByTestId("plugin-actions")).toBeNull();
    } finally {
      compact.slot.lifecycle.unmount();
    }
  });

  it("retains the host model picker and submits the draft through the host action", async () => {
    const { slot, run } = await mountComposer();
    try {
      expect(await slot.findByText("Host model picker")).toBeTruthy();
      const submit = slot.getByRole("button", { name: "Submit (Enter)" });
      await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
      fireEvent.click(submit);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("keeps host stop behavior when a turn is running", async () => {
    const onStop = vi.fn();
    const { slot } = await mountComposer({
      submission: {
        disabled: true,
        isRunning: true,
        onStop,
        enter: {
          kind: "queue",
          requiresInput: true,
          shortcut: { label: "Enter", ariaKeyshortcuts: "Enter" },
          run: vi.fn(),
        },
        modifier: null,
        showModifierInMenu: false,
      },
    });
    try {
      fireEvent.click(await slot.findByRole("button", { name: "Stop run" }));
      expect(onStop).toHaveBeenCalledOnce();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("keeps the Save draft slot in compact composers", async () => {
    const { slot } = await mountComposer({ compact: { when: "always", placeholder: "Follow up" } });
    try {
      expect(slot.queryByRole("button", { name: "Send options" })).toBeNull();
      const actions = slot.container.querySelector("[data-t3-composer-save-action]");
      expect(actions?.closest("[data-promptbox-expanded-only]")).toBeNull();
      expect(actions?.closest("[data-promptbox-standard-actions]")).toBeTruthy();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("renders a compact composer without the expanded model controls", async () => {
    const { slot } = await mountComposer({ compact: { when: "always", placeholder: "Follow up" } });
    try {
      expect(slot.queryByText("Host model picker")).toBeNull();
      expect(slot.container.querySelector("[data-promptbox-compact]")).toBeTruthy();
      expect(await slot.findByRole("button", { name: "Submit (Enter)" })).toBeTruthy();
    } finally {
      slot.lifecycle.unmount();
    }
  });
});

// The SDK harness does not resolve other plugins' inline/menu contributions.
// Mount this direct action with the availability supplied by that host-filtered metadata.
describe("Save draft SDK action", () => {
  it.each(["expanded", "compact"] as const)(
    "saves without sending in %s layout",
    async (layout) => {
      const { slot: editor, run, renderer, scope } = await mountComposer();
      const slot = renderSlot(
        { component: () => <SaveDraftAction available /> },
        {},
        {
          composer: { scope, text: "A draft", layout },
          composerRenderer: renderer,
        },
      );
      try {
        fireEvent.click(await slot.findByRole("button", { name: "Save draft" }));
        await waitFor(() =>
          expect(slot.inspection.composer.submits).toEqual([
            {
              experimental_mode: "queue-if-active",
              experimental_data: { kind: "draft" },
            },
          ]),
        );
        expect(run).not.toHaveBeenCalled();
      } finally {
        slot.lifecycle.unmount();
        editor.lifecycle.unmount();
      }
    },
  );

  it("hides Save draft in queued-message editors even when mounted directly", async () => {
    const {
      slot: editor,
      renderer,
      scope,
    } = await mountComposer(
      { surface: "thread" },
      {
        kind: "queued-message",
        threadId: "thread-1",
        queuedMessageId: "queued-1",
      },
    );
    const slot = renderSlot(
      { component: () => <SaveDraftAction available /> },
      {},
      {
        composer: { scope, text: "A draft" },
        composerRenderer: renderer,
      },
    );
    try {
      expect(slot.queryByRole("button", { name: "Save draft" })).toBeNull();
    } finally {
      slot.lifecycle.unmount();
      editor.lifecycle.unmount();
    }
  });

  it("does not register a global action group or render without the Drafts contribution", async () => {
    const { slot: editor, app, renderer, scope } = await mountComposer();
    const slot = renderSlot(
      { component: () => <SaveDraftAction available={false} /> },
      {},
      {
        composer: { scope, text: "A draft" },
        composerRenderer: renderer,
      },
    );
    try {
      expect(app.composerCustomizations).toHaveLength(0);
      expect(slot.queryByRole("button", { name: "Save draft" })).toBeNull();
    } finally {
      slot.lifecycle.unmount();
      editor.lifecycle.unmount();
    }
  });

  it("hides Save draft in hostless thread-surface story editors", async () => {
    const {
      slot: editor,
      renderer,
      scope,
    } = await mountComposer(
      { surface: "thread" },
      {
        kind: "new-thread",
        projectId: null,
      },
    );
    const slot = renderSlot(
      { component: () => <SaveDraftAction available /> },
      {},
      {
        composer: { scope, text: "A draft" },
        composerRenderer: renderer,
      },
    );
    try {
      expect(slot.queryByRole("button", { name: "Save draft" })).toBeNull();
    } finally {
      slot.lifecycle.unmount();
      editor.lifecycle.unmount();
    }
  });
});
