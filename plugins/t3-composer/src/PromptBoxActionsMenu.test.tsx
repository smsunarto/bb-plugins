// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { PromptBoxActionsMenu } from "./PromptBoxActionsMenu";

const actions = [{ kind: "skills", text: "/skills" }] as const;

describe("PromptBoxActionsMenu on a phone", () => {
  afterEach(cleanup);

  it("opens the file picker from the + without a drawer", () => {
    const onAttach = vi.fn();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <PromptBoxActionsMenu actions={actions as never} onAttach={onAttach} onAction={vi.fn()} />
      </CompactViewportOverrideProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Skills")).toBeNull();
  });

  it("keeps the editor focused when the + is pressed", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <textarea aria-label="Prompt" />
        <PromptBoxActionsMenu actions={actions as never} onAttach={vi.fn()} onAction={vi.fn()} />
      </CompactViewportOverrideProvider>,
    );
    const button = screen.getByRole("button", { name: "Attach files" });
    expect(fireEvent.pointerDown(button)).toBe(false);
    expect(fireEvent.mouseDown(button)).toBe(false);
  });

  it("keeps the menu when attachments are unavailable", () => {
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <PromptBoxActionsMenu actions={actions as never} onAction={vi.fn()} />
      </CompactViewportOverrideProvider>,
    );
    expect(screen.getByRole("button", { name: "Prompt actions" })).toBeTruthy();
  });
});
