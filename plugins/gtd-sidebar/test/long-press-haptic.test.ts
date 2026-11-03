import assert from "node:assert/strict";
import { afterEach, it } from "bun:test";
import { createElement } from "react";
import { installDom } from "@bb-plugins/testing";

installDom();
const { act, fireEvent, render } = await import("@testing-library/react");
const { IOS_LONG_PRESS_MS, useIosLongPress } = await import("../hooks/use-ios-long-press.ts");

function Row({ onLongPress, enabled }: { onLongPress: () => void; enabled?: boolean }) {
  const { handlers } = useIosLongPress(onLongPress, { enabled });
  return createElement("div", { "data-testid": "row", ...handlers });
}

afterEach(() => {
  delete (window as { bb?: unknown }).bb;
});

it("plays a native medium impact in BB's mobile app when the long press lands", async () => {
  const posted: unknown[] = [];
  (window as { bb?: unknown }).bb = {
    native: { capabilities: ["haptic"], post: (message: unknown) => posted.push(message) },
  };
  let pressed = 0;
  const { getByTestId } = render(createElement(Row, { onLongPress: () => pressed++ }));
  const row = getByTestId("row");

  fireEvent.touchStart(row, { touches: [{ clientX: 0, clientY: 0 }] });
  assert.deepEqual(posted, []);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, IOS_LONG_PRESS_MS + 50));
  });
  fireEvent.touchEnd(row);

  assert.equal(pressed, 1);
  assert.deepEqual(posted, [{ type: "haptic", kind: "impact-medium" }]);
});

it("drops a hold that is still down when the row stops taking long presses", async () => {
  let pressed = 0;
  const onLongPress = () => pressed++;
  const view = render(createElement(Row, { onLongPress }));

  fireEvent.touchStart(view.getByTestId("row"), { touches: [{ clientX: 0, clientY: 0 }] });
  // The viewport widens past compact mid-hold, so the touch sheet is gone.
  view.rerender(createElement(Row, { onLongPress, enabled: false }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, IOS_LONG_PRESS_MS + 50));
  });

  assert.equal(pressed, 0);
});
