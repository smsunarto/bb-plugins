// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { resetEscapeLayers } from "../../escape.ts";
import { Button } from "./button.tsx";
import { Dialog, DialogContent, DialogTitle } from "./dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";

beforeAll(() => {
  installTestPluginRuntime();
});

afterEach(() => {
  cleanup();
  resetEscapeLayers();
  document.body.innerHTML = "";
});

/** Escape on whatever has focus, as a reader presses it. */
const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

/** Opens a Radix menu from the keyboard; jsdom has no PointerEvent for a click. */
const openMenu = (trigger: HTMLElement) => {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
};

function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <div data-bb-plugin="source-control">
      <Button onClick={() => setOpen(true)}>Open dialog</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Merge</DialogTitle>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>Method</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Squash</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </DialogContent>
      </Dialog>
    </div>
  );
}

test("overlays portal into a scope root named for the plugin", () => {
  const view = render(<Fixture />);
  fireEvent.click(view.getByText("Open dialog"));
  const dialog = view.getByRole("dialog");
  expect(dialog.closest("[data-bb-plugin='source-control']")).not.toBeNull();
});

test("Escape closes the innermost overlay first, and bb never sees it", () => {
  const bb = vi.fn();
  const leave = (event: KeyboardEvent) => {
    if (event.key === "Escape") bb();
  };
  document.addEventListener("keydown", leave);
  const view = render(<Fixture />);
  fireEvent.click(view.getByText("Open dialog"));
  act(() => openMenu(view.getByText("Method")));
  expect(view.getByRole("menu")).toBeTruthy();

  act(() => void escape());
  expect(view.queryByRole("menu")).toBeNull();
  expect(view.getByRole("dialog")).toBeTruthy();

  act(() => void escape());
  expect(view.queryByRole("dialog")).toBeNull();
  expect(bb).not.toHaveBeenCalled();
  document.removeEventListener("keydown", leave);
});
