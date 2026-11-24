// @vitest-environment jsdom
// The `@` and `/` menus in a mounted composer, with BB's mention and command search stubbed.
import { useEffect } from "react";
import { act, fireEvent, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useComposer } from "@get-bb/plugin-sdk/app";
import type {
  ComposerDraftReplacement,
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
  let replaceDraft: ((draft: ComposerDraftReplacement) => void) | undefined;
  function ComposerWithHostDraft() {
    const { replace } = useComposer();
    useEffect(() => {
      replaceDraft = replace;
    }, [replace]);
    return <composer.component />;
  }
  const slot = renderSlot(
    { component: ComposerWithHostDraft },
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
  return { slot, run, type, deleteBack, element, replaceDraft };
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
  it.each(["click", "Enter"])(
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

  it("sends plain text ending in /handoff after the menu is dismissed", async () => {
    search.mention = searchState([]);
    search.command = searchState([
      { key: "commands", label: "Commands", suggestions: [command("handoff", "builtin")] },
    ]);
    const { slot, run, type, element } = await mountComposer("thread");
    const text = "List the flags for /handoff";
    run.mockImplementation(() => slot.composer.draft);
    try {
      type(text);
      await waitFor(() => slot.getByTitle("handoff"));
      fireEvent.keyDown(element, { key: "Escape" });
      fireEvent.click(slot.getByRole("button", { name: "Submit (Enter)" }));
      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveReturnedWith(expect.objectContaining({ text, mentions: [] }));
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("preserves the original whitespace of an indented handoff follow-up", async () => {
    search.mention = searchState([]);
    search.command = searchState([
      { key: "commands", label: "Commands", suggestions: [command("handoff", "builtin")] },
    ]);
    const { slot, run, type, replaceDraft } = await mountComposer("thread");
    const followUp = "    print(1) ";
    const prefix = "Continue from @thread:t1";
    if (!replaceDraft) throw new Error("Composer draft handle was not mounted");
    run.mockImplementation(() => {
      const { text, mentions } = slot.composer.draft;
      expect(mentions[0]).toMatchObject({ kind: "command", origin: "builtin", from: 0, to: 8 });
      // BB 0.50.1 strips the command and trimStarts the rest before seeding the handoff.
      replaceDraft({
        text: prefix + "\n\n" + text.slice(8).trimStart(),
        mentions: [
          {
            kind: "thread",
            threadId: "t1",
            label: "Source",
            from: "Continue from ".length,
            to: prefix.length,
          },
        ],
      });
    });
    try {
      type(followUp + "/hand");
      fireEvent.mouseDown(await waitFor(() => slot.getByTitle("handoff")));
      expect(run).toHaveBeenCalledOnce();
      expect(slot.composer.draft.text).toBe(prefix + "\n\n" + followUp);
    } finally {
      slot.lifecycle.unmount();
    }
  });

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
