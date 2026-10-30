// @vitest-environment jsdom
import { useState } from "react";
import { createPortal } from "react-dom";
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  ComposerDraftSnapshot,
  ComposerSelection,
  ExperimentalComposerHistory,
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

type SlotOptions = NonNullable<Parameters<typeof renderSlot>[2]>;

async function mountComposer(
  inputOverrides: Partial<ExperimentalComposerInput> = {},
  scope: ExperimentalComposerRendererApi["view"]["scope"] = { kind: "new-thread", projectId: "p1" },
  options: Pick<SlotOptions, "providers" | "sdk"> & {
    selection?: ComposerSelection;
    text?: string;
  } = {},
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
      composer: {
        scope,
        text: options.text ?? "A draft",
        ...(options.selection ? { selection: options.selection } : {}),
      },
      composerRenderer: renderer,
      ...(options.providers ? { providers: options.providers } : {}),
      ...(options.sdk ? { sdk: options.sdk } : {}),
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

  it("shows plugin actions after the model controls", async () => {
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
  });

  it("submits the draft through the host action", async () => {
    const { slot, run } = await mountComposer();
    try {
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

  it("recalls the newest entry on ArrowUp and restores the original draft on ArrowDown past it", async () => {
    const draft = (text: string): ComposerDraftSnapshot => ({
      text,
      mentions: [],
      attachments: [],
    });
    const selected: string[] = [];
    // BB applies a selected entry to the composer and republishes it as the current draft.
    const history: ExperimentalComposerHistory = {
      currentDraft: draft(""),
      entries: [draft("Newest prompt"), draft("Older prompt")],
      onSelectEntry: (entry) => {
        selected.push(entry.text);
        history.currentDraft = entry;
      },
    };
    const { slot } = await mountComposer({ history }, undefined, { text: "" });
    try {
      await waitFor(() =>
        expect(document.activeElement?.getAttribute("contenteditable")).toBe("true"),
      );
      const editor = document.activeElement as HTMLElement;
      fireEvent.keyDown(editor, { key: "ArrowUp" });
      fireEvent.keyDown(editor, { key: "ArrowUp" });
      fireEvent.keyDown(editor, { key: "ArrowDown" });
      fireEvent.keyDown(editor, { key: "ArrowDown" });
      expect(selected).toEqual(["Newest prompt", "Older prompt", "Newest prompt", ""]);
      // Past the original draft there is no session left to step through.
      fireEvent.keyDown(editor, { key: "ArrowDown" });
      expect(selected).toHaveLength(4);
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

  it("stays expanded without a collapse button when BB asks for the compact form", async () => {
    const { slot } = await mountComposer({
      compact: { when: "always", placeholder: "Follow up" },
      onCollapse: () => {},
    });
    try {
      expect(await slot.findByText("Host model picker")).toBeTruthy();
      expect(slot.container.querySelector("[data-promptbox-compact]")).toBeNull();
      expect(slot.container.querySelector("[data-promptbox-collapsed]")).toBeNull();
      expect(slot.queryByRole("button", { name: "Collapse prompt box" })).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });
});

/** BB's picker as the driver sees it: a dialog trigger and a popover with a Daybreak switch. */
function FakeBbPicker(props: { withSwitch?: boolean }) {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? "fake-bb-popover" : undefined}
        onClick={() => setOpen(!open)}
      >
        BB picker
      </button>
      {open
        ? createPortal(
            <div id="fake-bb-popover">
              <div role="option" aria-selected="true">
                GPT-6-Luna
              </div>
              {props.withSwitch === false ? null : (
                <button
                  type="button"
                  role="switch"
                  aria-label="Daybreak"
                  aria-checked={on}
                  onClick={() => setOn(!on)}
                />
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

const PROVIDERS = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    available: true,
    logoUrl: null,
    reasoningLevels: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
      { id: "max", label: "Max" },
    ],
    // As the live provider does: Fast declared for the provider, no per-model list.
    capabilities: { supportsServiceTier: true },
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast" },
    ],
  },
  { id: "codex", displayName: "Codex", available: true, logoUrl: null },
  { id: "devin", displayName: "Devin", available: true, logoUrl: null },
];

function catalogModel(model: string, displayName: string, extra: object = {}) {
  return {
    id: model,
    model,
    displayName,
    description: "",
    isDefault: false,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "" },
      { reasoningEffort: "high", description: "" },
      { reasoningEffort: "max", description: "" },
    ],
    ...extra,
  };
}

const MODELS: Record<string, object[]> = {
  "claude-code": [
    catalogModel("claude-opus-5-5", "Opus 5.5"),
    catalogModel("claude-sonnet-5-5", "Sonnet 5.5"),
  ],
  codex: [
    // As live: Daybreak is an on/off agent option, fixed on some models.
    catalogModel("gpt-6.1-sol", "GPT-6.1-Sol", {
      sessionOptions: [
        { id: "daybreak", label: "Daybreak", type: "boolean", value: false, fixed: true },
      ],
    }),
    catalogModel("gpt-6-luna", "GPT-6-Luna", {
      sessionOptions: [{ id: "daybreak", label: "Daybreak", type: "boolean", value: false }],
    }),
    catalogModel("gpt-5.6-luna", "GPT-5.6-Luna", {
      sessionOptions: [{ id: "daybreak", label: "Daybreak", type: "boolean", value: false }],
    }),
  ],
  devin: [
    catalogModel("acp-default", "Agent default", {
      sessionOptions: [{ id: "mode", label: "Mode", type: "select", value: "a", values: [] }],
    }),
  ],
};

function pickerOptions(selection: ComposerSelection, sdk: Record<string, unknown> = {}) {
  return {
    selection,
    providers: { status: "ready" as const, providers: PROVIDERS as never },
    sdk: {
      ...sdk,
      providers: {
        models: async (args?: { providerId?: string }) => ({
          models: MODELS[args?.providerId ?? ""] ?? [],
          modelLoadError: null,
          providers: [],
          permissionCeiling: "full",
          selectedOnlyModels: [],
        }),
      },
    } as never,
  };
}

/** Opens the picker once the composer's mount-time editor autofocus has run, so it cannot dismiss it. */
async function openModelPicker(slot: Awaited<ReturnType<typeof mountComposer>>["slot"]) {
  await waitFor(() => expect(document.activeElement?.getAttribute("contenteditable")).toBe("true"));
  fireEvent.click(await slot.findByRole("button", { name: "Opus 5.5" }));
  return slot.findByPlaceholderText("Search models...");
}

const OPUS_HIGH = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" };

describe("T3 Code model picker", () => {
  it("shows the model with its effort and switches models through the composer selection", async () => {
    const { slot } = await mountComposer({}, undefined, pickerOptions(OPUS_HIGH));
    try {
      expect(await slot.findByRole("button", { name: "Effort: High" })).toBeTruthy();
      expect(slot.queryByText("Host model picker")).toBeNull();
      await openModelPicker(slot);
      fireEvent.click(await slot.findByText("Sonnet 5.5"));
      await waitFor(() =>
        expect(slot.composer.selections.at(-1)).toMatchObject({ model: "claude-sonnet-5-5" }),
      );
      expect(slot.queryByPlaceholderText("Search models...")).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("searches every provider's models and picks the highlighted one with Enter", async () => {
    const { slot } = await mountComposer({}, undefined, pickerOptions(OPUS_HIGH));
    try {
      const search = await openModelPicker(slot);
      fireEvent.change(search, { target: { value: "luna" } });
      expect(await slot.findByText("GPT-6-Luna")).toBeTruthy();
      expect(slot.queryByText("Sonnet 5.5")).toBeNull();
      fireEvent.keyDown(search, { key: "Enter" });
      await waitFor(() =>
        expect(slot.composer.selections.at(-1)).toMatchObject({
          providerId: "codex",
          model: "gpt-6-luna",
        }),
      );
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("exposes the list as a combobox whose highlight screen readers follow", async () => {
    const { slot } = await mountComposer({}, undefined, pickerOptions(OPUS_HIGH));
    try {
      const search = await openModelPicker(slot);
      await slot.findByRole("option", { name: /Sonnet 5\.5/ });
      expect(search.getAttribute("role")).toBe("combobox");
      const listbox = slot.getByRole("listbox", { name: "Models" });
      expect(search.getAttribute("aria-controls")).toBe(listbox.id);
      expect(slot.getByRole("option", { name: /Opus 5\.5/ }).getAttribute("aria-selected")).toBe(
        "true",
      );
      fireEvent.keyDown(search, { key: "ArrowDown" });
      const active = document.getElementById(search.getAttribute("aria-activedescendant") ?? "");
      expect(active?.textContent).toContain("Sonnet 5.5");
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("favorites the highlighted model from the keyboard and keeps favorites in their own tab", async () => {
    localStorage.clear();
    const { slot } = await mountComposer({}, undefined, pickerOptions(OPUS_HIGH));
    try {
      const search = await openModelPicker(slot);
      await slot.findByRole("option", { name: /Sonnet 5\.5/ });
      fireEvent.keyDown(search, { key: "ArrowDown" });
      fireEvent.keyDown(search, { key: "d", ctrlKey: true, metaKey: true });
      expect(await slot.findByRole("option", { name: /Sonnet 5\.5.*favorite/ })).toBeTruthy();
      // Favorites move to the top; the highlight stays on Sonnet, so a second press removes it.
      fireEvent.keyDown(search, { key: "d", ctrlKey: true, metaKey: true });
      await waitFor(() => expect(slot.queryByRole("option", { name: /favorite/ })).toBeNull());
      fireEvent.keyDown(search, { key: "d", ctrlKey: true, metaKey: true });
      expect(await slot.findByRole("option", { name: /Sonnet 5\.5.*favorite/ })).toBeTruthy();
      fireEvent.click(slot.getByRole("button", { name: "Favorites" }));
      await waitFor(() => expect(slot.getAllByRole("option")).toHaveLength(1));
      expect(slot.getByRole("option").textContent).toContain("Sonnet 5.5");
    } finally {
      slot.lifecycle.unmount();
      localStorage.clear();
    }
  });

  it("closes and takes no picks while BB hides the composer for a pending question", async () => {
    const { slot } = await mountComposer({}, undefined, pickerOptions(OPUS_HIGH));
    try {
      await openModelPicker(slot);
      await slot.findByRole("option", { name: /Sonnet 5\.5/ });
      // BB hides the composer while the agent waits on a question or approval.
      slot.container.firstElementChild?.setAttribute("hidden", "");
      await waitFor(() => expect(slot.queryByRole("listbox")).toBeNull());
      expect(slot.composer.selections).toHaveLength(0);
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("sets effort from the effort panel", async () => {
    // jsdom has no PointerEvent, and Radix opens menus on a primary-button pointerdown.
    window.PointerEvent ??= class extends MouseEvent {} as typeof PointerEvent;
    const { slot } = await mountComposer({}, undefined, pickerOptions(OPUS_HIGH));
    try {
      const traits = await slot.findByRole("button", { name: "Effort: High" });
      await waitFor(() =>
        expect(document.activeElement?.getAttribute("contenteditable")).toBe("true"),
      );
      fireEvent.pointerDown(traits, { button: 0, ctrlKey: false, pointerType: "mouse" });
      const slider = await slot.findByRole("slider", { name: "Effort" });
      // After a pointer open the menu has focus; Right reaches the slider, and Up from the
      // slider reaches the header's last button, reset.
      await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("menu"));
      fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
      expect(document.activeElement).toBe(slider);
      fireEvent.keyDown(document.activeElement!, { key: "End" });
      await waitFor(() =>
        expect(slot.composer.selections.at(-1)).toMatchObject({ reasoningLevel: "max" }),
      );
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      const reset = await slot.findByRole("menuitem", { name: "Reset effort to High" });
      expect(document.activeElement).toBe(reset);
      // Reset hides once the default applies, so it hands focus back to the slider first.
      fireEvent.click(reset);
      await waitFor(() =>
        expect(slot.composer.selections.at(-1)).toMatchObject({ reasoningLevel: "high" }),
      );
      expect(document.activeElement).toBe(slider);
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("cycles the speed from the bolt in the effort panel", async () => {
    window.PointerEvent ??= class extends MouseEvent {} as typeof PointerEvent;
    const { slot } = await mountComposer({}, undefined, pickerOptions(OPUS_HIGH));
    try {
      const traits = await slot.findByRole("button", { name: "Effort: High" });
      await waitFor(() =>
        expect(document.activeElement?.getAttribute("contenteditable")).toBe("true"),
      );
      fireEvent.pointerDown(traits, { button: 0, ctrlKey: false, pointerType: "mouse" });
      fireEvent.click(await slot.findByRole("menuitem", { name: /^Speed: Normal/ }));
      await waitFor(() =>
        expect(slot.composer.selections.at(-1)).toMatchObject({ serviceTier: "fast" }),
      );
      // The panel stays open, the bolt now reads Fast, and the effort pill names the speed.
      expect(await slot.findByRole("button", { name: "Effort: High · Fast" })).toBeTruthy();
      fireEvent.click(await slot.findByRole("menuitem", { name: /^Speed: Fast/ }));
      await waitFor(() =>
        expect(slot.composer.selections.at(-1)).toMatchObject({ serviceTier: "default" }),
      );
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("switches Daybreak through BB's hidden picker", async () => {
    window.PointerEvent ??= class extends MouseEvent {} as typeof PointerEvent;
    const { slot } = await mountComposer(
      { executionControls: <FakeBbPicker /> },
      undefined,
      pickerOptions({ providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high" }),
    );
    try {
      const traits = await slot.findByRole("button", { name: "Effort: high" });
      await waitFor(() =>
        expect(document.activeElement?.getAttribute("contenteditable")).toBe("true"),
      );
      fireEvent.pointerDown(traits, { button: 0, ctrlKey: false, pointerType: "mouse" });
      // The panel reads the switch from BB's picker, then sets it there.
      fireEvent.click(await slot.findByRole("menuitem", { name: "Daybreak: off" }));
      expect(await slot.findByRole("menuitem", { name: "Daybreak: on" })).toBeTruthy();
      expect(await slot.findByRole("button", { name: "Effort: high · Daybreak" })).toBeTruthy();
      // BB's popover closed again, and only the panel is open.
      expect(document.getElementById("fake-bb-popover")).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("hides Daybreak where BB's picker does not offer it", async () => {
    window.PointerEvent ??= class extends MouseEvent {} as typeof PointerEvent;
    const { slot } = await mountComposer(
      { executionControls: <FakeBbPicker withSwitch={false} /> },
      undefined,
      pickerOptions({ providerId: "codex", model: "gpt-5.6-luna", reasoningLevel: "low" }),
    );
    try {
      const traits = await slot.findByRole("button", { name: "Effort: low" });
      await waitFor(() =>
        expect(document.activeElement?.getAttribute("contenteditable")).toBe("true"),
      );
      fireEvent.pointerDown(traits, { button: 0, ctrlKey: false, pointerType: "mouse" });
      expect(await slot.findByRole("menuitem", { name: "Daybreak: checking" })).toBeTruthy();
      await waitFor(() => expect(slot.queryByRole("menuitem", { name: /^Daybreak/ })).toBeNull(), {
        timeout: 4000,
      });
      expect(slot.queryByRole("alert")).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("keeps BB's read-only control in a queued-message editor", async () => {
    const { slot } = await mountComposer(
      {},
      { kind: "queued-message", threadId: "t-queued", queuedMessageId: "q1" },
      pickerOptions(OPUS_HIGH),
    );
    try {
      expect(await slot.findByText("Host model picker")).toBeTruthy();
      expect(slot.queryByRole("button", { name: "Opus 5.5" })).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("reads a thread's models from its environment", async () => {
    const requested: unknown[] = [];
    const options = pickerOptions(OPUS_HIGH, {
      threads: { get: async () => ({ id: "t-env", environmentId: "env-remote" }) },
    });
    const models = (options.sdk as { providers: { models: (args: unknown) => unknown } }).providers
      .models;
    (options.sdk as { providers: { models: (args: unknown) => unknown } }).providers.models = (
      args,
    ) => {
      requested.push(args);
      return models(args);
    };
    const { slot } = await mountComposer({}, { kind: "thread", threadId: "t-env" }, options);
    try {
      expect(await slot.findByRole("button", { name: "Opus 5.5" })).toBeTruthy();
      expect(requested[0]).toMatchObject({
        environmentId: "env-remote",
        providerId: "claude-code",
      });
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("keeps these pickers while a new thread's machine is still being read", async () => {
    const draft = await mountComposer({}, undefined, pickerOptions(OPUS_HIGH));
    expect(await draft.slot.findByRole("button", { name: "Opus 5.5" })).toBeTruthy();
    draft.slot.lifecycle.unmount();
    const { slot } = await mountComposer(
      {},
      { kind: "thread", threadId: "t-just-sent" },
      pickerOptions(OPUS_HIGH, { threads: { get: () => new Promise(() => {}) } }),
    );
    try {
      expect(await slot.findByRole("button", { name: "Opus 5.5" })).toBeTruthy();
      expect(slot.queryByText("Host model picker")).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("falls back to BB's picker rather than another machine when a thread lookup fails", async () => {
    const { slot } = await mountComposer(
      {},
      { kind: "thread", threadId: "t-offline" },
      pickerOptions(OPUS_HIGH, {
        threads: {
          get: async () => {
            throw new Error("offline");
          },
        },
      }),
    );
    try {
      expect(await slot.findByText("Host model picker")).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(slot.queryByRole("button", { name: "Opus 5.5" })).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("shows these pickers for a model whose agent options are only on/off, as in a new Codex thread", async () => {
    const { slot } = await mountComposer(
      {},
      undefined,
      pickerOptions({ providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high" }),
    );
    try {
      expect(await slot.findByRole("button", { name: "GPT-6-Luna" })).toBeTruthy();
      expect(slot.queryByText("Host model picker")).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("keeps BB's picker for a model with an agent option to choose from", async () => {
    const { slot } = await mountComposer(
      {},
      undefined,
      pickerOptions({ providerId: "devin", model: "acp-default", reasoningLevel: "high" }),
    );
    try {
      expect(await slot.findByText("Host model picker")).toBeTruthy();
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
