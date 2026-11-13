import assert from "node:assert/strict";
import { afterEach, it } from "bun:test";
import { createElement } from "react";
import { installDom } from "@bb-plugins/testing";

installDom();
const { act, fireEvent, render } = await import("@testing-library/react");
const { IOS_LONG_PRESS_MS, useIosLongPress } = await import("../hooks/use-ios-long-press.ts");

/** A list of two rows under one recognizer; only `row` takes a long press. */
function List({ onLongPress, enabled }: { onLongPress: (id: string) => void; enabled?: boolean }) {
  const handlers = useIosLongPress<string>(({ target }) => onLongPress(target), {
    enabled,
    resolve: (element) => element.closest("[data-row]")?.getAttribute("data-row") ?? null,
  });
  return createElement(
    "div",
    handlers,
    createElement("div", { "data-testid": "row", "data-row": "a" }),
    createElement("div", { "data-testid": "header" }),
  );
}

afterEach(() => {
  delete (window as { bb?: unknown }).bb;
});

it("plays a native medium impact in BB's mobile app when the long press lands", async () => {
  const posted: unknown[] = [];
  (window as { bb?: unknown }).bb = {
    native: { capabilities: ["haptic"], post: (message: unknown) => posted.push(message) },
  };
  const pressed: string[] = [];
  const { getByTestId } = render(
    createElement(List, { onLongPress: (id: string) => pressed.push(id) }),
  );
  const row = getByTestId("row");

  fireEvent.touchStart(row, { touches: [{ clientX: 0, clientY: 0 }] });
  assert.deepEqual(posted, []);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, IOS_LONG_PRESS_MS + 50));
  });
  fireEvent.touchEnd(row);

  assert.deepEqual(pressed, ["a"]);
  assert.deepEqual(posted, [{ type: "haptic", kind: "impact-medium" }]);
});

it("holds only what the list resolves to a row", async () => {
  const pressed: string[] = [];
  const { getByTestId } = render(
    createElement(List, { onLongPress: (id: string) => pressed.push(id) }),
  );
  fireEvent.touchStart(getByTestId("header"), { touches: [{ clientX: 0, clientY: 0 }] });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, IOS_LONG_PRESS_MS + 50));
  });
  assert.deepEqual(pressed, []);
});

it("drops a hold that is still down when the row stops taking long presses", async () => {
  let pressed = 0;
  const onLongPress = () => pressed++;
  const view = render(createElement(List, { onLongPress }));

  fireEvent.touchStart(view.getByTestId("row"), { touches: [{ clientX: 0, clientY: 0 }] });
  // The viewport widens past compact mid-hold, so the touch sheet is gone.
  view.rerender(createElement(List, { onLongPress, enabled: false }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, IOS_LONG_PRESS_MS + 50));
  });

  assert.equal(pressed, 0);
});
