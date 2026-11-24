// @vitest-environment jsdom
// The `@` and `/` menus in a mounted composer, with BB's mention and command search stubbed.
import { act, fireEvent, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  ComposerDraftSnapshot,
  ExperimentalComposerCommandSuggestion,
  ExperimentalComposerInput,
  ExperimentalComposerMentionSuggestion,
  ExperimentalComposerRendererApi,
} from "@get-bb/plugin-sdk/app";

interface SearchState<Group> {
  status: "idle" | "loading" | "ready" | "error";
  refreshing: boolean;
  groups: readonly Group[];
  search: () => void;
}

const search = vi.hoisted(() => ({
  mention: null as unknown,
  command: null as unknown,
}));

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...sdk,
    experimental_useComposerMentionSearch: () => search.mention,
    experimental_useComposerCommandSearch: () => search.command,
  };
});

function searchState<Group>(groups: readonly Group[]): SearchState<Group> {
  return { status: "ready", refreshing: false, groups, search: () => {} };
}

function pathMention(path: string): ExperimentalComposerMentionSuggestion {
  return {
    kind: "path",
    key: path,
    text: path,
    mention: { kind: "path", source: "workspace", entryKind: "file", path, label: path },
  };
}

function command(
  name: string,
  origin: ExperimentalComposerCommandSuggestion["origin"],
): ExperimentalComposerCommandSuggestion {
  return {
    kind: "command",
    name,
    source: origin === "builtin" ? "command" : "skill",
    origin,
    description: null,
    argumentHint: null,
  };
}

async function mountComposer(surface: ExperimentalComposerInput["surface"] = "new-thread") {
  const run = vi.fn();
  const input: ExperimentalComposerInput = {
    surface,
    executionControls: null,
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
  };
  const renderer: ExperimentalComposerRendererApi = {
    input,
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
        scope:
          surface === "thread"
            ? { kind: "thread", threadId: "t1" }
            : { kind: "new-thread", projectId: "p1" },
        text: "",
      },
      composerRenderer: renderer,
      rpc: { starredModels: () => ({ models: [] }), changeStarredModels: () => ({ models: [] }) },
    },
  );
  const element = await waitFor(() => {
    const found = slot.container.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!found) throw new Error("editor not mounted");
    return found;
  });
  // Tiptap keeps its editor on the view's DOM node.
  const editor = (element as HTMLElement & { editor: Editor }).editor;
  const type = (text: string) => act(() => void editor.commands.insertContent(text));
  const deleteBack = () =>
    act(() => {
      const { from } = editor.state.selection;
      editor.commands.deleteRange({ from: from - 1, to: from });
    });
  return { slot, run, type, deleteBack, element };
}

afterEach(() => {
  search.mention = searchState([]);
  search.command = searchState([]);
});

describe("@ mention menu", () => {
  it("keeps a single-word query that matches nothing open", async () => {
    search.mention = searchState([]);
    search.command = searchState([]);
    const { slot, type } = await mountComposer();
    try {
      type("@nothing");
      await waitFor(() => expect(slot.queryByText("No matching mentions")).not.toBeNull());
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("closes a multiword query once the search settles with no matches, and stays closed while typing on", async () => {
    search.mention = searchState([]);
    search.command = searchState([]);
    const { slot, type } = await mountComposer();
    try {
      type("@see you");
      await waitFor(() => expect(slot.queryByText("No matching mentions")).toBeNull());
      type(" later");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(slot.queryByText("No matching mentions")).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("reopens a closed multiword query once a shorter query matches", async () => {
    search.mention = searchState([]);
    search.command = searchState([]);
    const { slot, type, deleteBack } = await mountComposer();
    try {
      type("@src index");
      await waitFor(() => expect(slot.queryByText("No matching mentions")).toBeNull());
      // Still nothing to show: the reopened menu waits for a match instead of an empty list.
      deleteBack();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(slot.queryByText("No matching mentions")).toBeNull();
      search.mention = searchState([
        { key: "workspace", label: "Workspace", suggestions: [pathMention("src/index.ts")] },
      ]);
      deleteBack();
      await waitFor(() => expect(slot.queryByText("src/index.ts")).not.toBeNull());
    } finally {
      slot.lifecycle.unmount();
    }
  });
});

describe("/ command menu", () => {
  it.each(["click", "Enter", "Escape then Enter"])(
    "submits mid-draft handoff as a leading built-in command via %s",
    async (action) => {
      search.mention = searchState([]);
      search.command = searchState([
        { key: "commands", label: "Commands", suggestions: [command("handoff", "builtin")] },
      ]);
      const { slot, run, type, element } = await mountComposer("thread");
      const submitted: ComposerDraftSnapshot[] = [];
      run.mockImplementation(() => {
        submitted.push(slot.composer.draft);
      });
      try {
        type(action === "click" ? "Review fixture /hand" : "Review fixture /handoff");
        const row = await waitFor(() => slot.getByTitle("handoff"));
        if (action === "click") {
          fireEvent.mouseDown(row);
        } else {
          if (action === "Escape then Enter") fireEvent.keyDown(element, { key: "Escape" });
          fireEvent.keyDown(element, { key: "Enter" });
        }
        await waitFor(() => expect(run).toHaveBeenCalledOnce());
        expect(submitted).toMatchObject([
          {
            text: expect.stringMatching(/^\/handoff Review fixture\s*$/),
            mentions: [
              {
                kind: "command",
                trigger: "/",
                origin: "builtin",
                source: "command",
                name: "handoff",
                from: 0,
                to: 8,
              },
            ],
          },
        ]);
      } finally {
        slot.lifecycle.unmount();
      }
    },
  );

  it.each([
    { origin: "builtin" as const, name: "compact", sends: true },
    { origin: "user" as const, name: "review", sends: false },
  ])("a click on a $origin command sends it: $sends", async ({ origin, name, sends }) => {
    search.mention = searchState([]);
    search.command = searchState([
      { key: "commands", label: "Commands", suggestions: [command(name, origin)] },
    ]);
    const { slot, run, type } = await mountComposer();
    try {
      type(`/${name.slice(0, 3)}`);
      const row = await waitFor(() => slot.getByTitle(name));
      fireEvent.mouseDown(row);
      if (sends) {
        await waitFor(() => expect(run).toHaveBeenCalledOnce());
      } else {
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(run).not.toHaveBeenCalled();
      }
    } finally {
      slot.lifecycle.unmount();
    }
  });
});
