// @vitest-environment jsdom
import { memo } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";
import { ComposerHandleProvider, useComposerHandle, usePickerComposer } from "./composer-handle";

describe("ComposerHandleProvider", () => {
  it("re-renders a picker when its selection changes, not when the draft does", async () => {
    const pickerRenders: string[] = [];
    const Picker = memo(function Picker() {
      const model = usePickerComposer().selection?.model ?? "none";
      pickerRenders.push(model);
      return <output data-testid="model">{model}</output>;
    });
    function Draft() {
      const composer = useComposerHandle();
      return (
        <>
          <output data-testid="text">{composer.text}</output>
          <button type="button" onClick={() => composer.replace({ text: "A draft", mentions: [] })}>
            Type
          </button>
          <button type="button" onClick={() => void composer.setSelection({ model: "sonnet" })}>
            Pick
          </button>
        </>
      );
    }
    const slot = renderSlot(
      {
        component: () => (
          <ComposerHandleProvider>
            <Picker />
            <Draft />
          </ComposerHandleProvider>
        ),
      },
      {},
      {
        composer: {
          scope: { kind: "new-thread", projectId: "p1" },
          text: "A",
          selection: { providerId: "claude-code", model: "opus" },
        },
      },
    );
    try {
      expect(slot.getByTestId("model").textContent).toBe("opus");
      const rendersBeforeTyping = pickerRenders.length;

      fireEvent.click(slot.getByRole("button", { name: "Type" }));
      await waitFor(() => expect(slot.getByTestId("text").textContent).toBe("A draft"));
      expect(pickerRenders).toHaveLength(rendersBeforeTyping);

      fireEvent.click(slot.getByRole("button", { name: "Pick" }));
      await waitFor(() => expect(slot.getByTestId("model").textContent).toBe("sonnet"));
    } finally {
      slot.lifecycle.unmount();
    }
  });
});
