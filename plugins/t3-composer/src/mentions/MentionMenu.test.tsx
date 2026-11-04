// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperimentalComposerMentionSuggestion } from "@get-bb/plugin-sdk/app";
import { MentionMenu } from "./MentionMenu";

afterEach(cleanup);

describe("MentionMenu", () => {
  it("shows a refresh spinner over current results without changing their layout", () => {
    const suggestion: ExperimentalComposerMentionSuggestion = {
      kind: "path",
      key: "src/index.ts",
      text: "src/index.ts",
      mention: {
        kind: "path",
        source: "workspace",
        entryKind: "file",
        path: "src/index.ts",
        label: "index.ts",
      },
    };
    const renderMenu = (refreshing: boolean) =>
      render(
        <MentionMenu
          state={{
            trigger: "mention",
            state: {
              kind: "results",
              refreshing,
              groups: [
                {
                  key: "workspace",
                  label: "Workspace",
                  suggestions: [suggestion],
                },
              ],
            },
          }}
          selectedIndex={0}
          onApply={vi.fn()}
        />,
      );

    const idle = renderMenu(false);
    const idleStatus = idle.container.querySelector("[role='status']");
    expect(idleStatus?.classList.contains("invisible")).toBe(true);
    expect(screen.queryByLabelText("Updating results")).toBeNull();
    idle.unmount();

    const refreshing = renderMenu(true);
    const refreshingStatus = refreshing.container.querySelector("[role='status']");
    expect(refreshingStatus?.classList.contains("invisible")).toBe(false);
    expect(screen.getByLabelText("Updating results")).toBe(refreshingStatus);
    expect(screen.getByText("index.ts")).not.toBeNull();
  });

  it("numbers rows across groups so keyboard selection follows display order", () => {
    const path = (name: string): ExperimentalComposerMentionSuggestion => ({
      kind: "path",
      key: name,
      text: name,
      mention: {
        kind: "path",
        source: "workspace",
        entryKind: "file",
        path: name,
        label: name,
      },
    });
    render(
      <MentionMenu
        state={{
          trigger: "mention",
          state: {
            kind: "results",
            refreshing: false,
            groups: [
              { key: "a", label: "A", suggestions: [path("one"), path("two")] },
              { key: "b", label: "B", suggestions: [path("three")] },
            ],
          },
        }}
        selectedIndex={2}
        onApply={vi.fn()}
      />,
    );

    expect(screen.getByText("three").closest("button")?.className).toContain("bg-state-active");
    expect(screen.getByText("two").closest("button")?.className).not.toContain("bg-state-active");
  });

  it("scrolls only when a later row is selected, not as results change under the first row", () => {
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    const path = (name: string): ExperimentalComposerMentionSuggestion => ({
      kind: "path",
      key: name,
      text: name,
      mention: { kind: "path", source: "workspace", entryKind: "file", path: name, label: name },
    });
    const menu = (names: string[], selectedIndex: number) => (
      <MentionMenu
        state={{
          trigger: "mention",
          state: {
            kind: "results",
            refreshing: false,
            groups: [{ key: "workspace", label: "Workspace", suggestions: names.map(path) }],
          },
        }}
        selectedIndex={selectedIndex}
        onApply={vi.fn()}
      />
    );
    const view = render(menu(["a.ts", "b.ts"], 0));
    view.rerender(menu(["a.ts", "b.ts", "c.ts"], 0));
    expect(scrollIntoView).not.toHaveBeenCalled();
    view.rerender(menu(["a.ts", "b.ts", "c.ts"], 2));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByText("c.ts").closest("button"));
    scrollIntoView.mockRestore();
  });
});
