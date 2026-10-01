import assert from "node:assert/strict";
import { afterEach, it } from "bun:test";
import { createElement } from "react";
import { installDom } from "@bb-kit/core/testing";

installDom();
const { act, fireEvent, render } = await import("@testing-library/react");
const { IOS_LONG_PRESS_MS, useIosLongPress } = await import("../hooks/use-ios-long-press.ts");

function Row({ onLongPress }: { onLongPress: () => void }) {
  const { handlers } = useIosLongPress(onLongPress);
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
